import { WebSocketServer } from "ws";
import express from "express";
import * as cp from "child_process";
import * as url from "url";
import * as rpc from "vscode-ws-jsonrpc";
import * as path from "path";
import * as jsonrpcserver from "vscode-ws-jsonrpc/server";
import nocache from "nocache";
import anonymize from "ip-anonymize";
import os from "os";
import http from "http";
import https from "https";
import fetch from "node-fetch";
import { text } from "stream/consumers";

let socketCounter = 0;

function logStats() {
  console.log(`[${new Date()}] Number of open sockets - ${socketCounter}`);
  console.log(
    `[${new Date()}] Free RAM - ${Math.round(
      os.freemem() / 1024 / 1024
    )} / ${Math.round(os.totalmem() / 1024 / 1024)} MB`
  );
}

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const environment = process.env.NODE_ENV;
const isDevelopment = environment === "development";

const crtFile = process.env.SSL_CRT_FILE;
const keyFile = process.env.SSL_KEY_FILE;

const app = express();

// Initialize Hugging Face configuration
const HF_TOKEN = process.env.HF_TOKEN;
const HF_AUTOCOMPLETION_ENDPOINT_URL =
  process.env.HF_AUTOCOMPLETION_ENDPOINT_URL;

if (!HF_TOKEN || !HF_AUTOCOMPLETION_ENDPOINT_URL) {
  console.warn(
    "HF_TOKEN or HF_AUTOCOMPLETION_ENDPOINT_URL environment variable is not set - code completion will not be available"
  );
}

// Add JSON parsing middleware for the code completion endpoint
app.use(express.json());

// Code completion endpoint
app.post("/api/code-completion", async (req, res) => {
  if (!HF_TOKEN || !HF_AUTOCOMPLETION_ENDPOINT_URL) {
    return res.status(500).json({
      completion: null,
      error:
        "Code completion is not configured - missing HF_TOKEN or endpoint URL",
    });
  }

  try {
    const { completionMetadata } = req.body;
    const { textBeforeCursor, trailingWhitespace } = completionMetadata;
    console.log("Code completion request:", textBeforeCursor);
    const solution = `Complete the following Lean 4 code:\n\n\`\`\`lean4\n${textBeforeCursor}`;

    const response = await fetch(HF_AUTOCOMPLETION_ENDPOINT_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${HF_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: solution,
        parameters: {
          max_new_tokens: 150,
          stop_strings: ["\n"],
        },
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("Hugging Face API error:", error);
      return res.status(response.status).json({
        completion: null,
        error: `Hugging Face API error: ${error}`,
      });
    }

    const data = await response.json();

    // Check if the response is an error
    if (typeof data === "object" && data !== null && "error" in data) {
      return res.json({
        completion: null,
        error: data.error,
      });
    }

    // Extract completion text
    if (!Array.isArray(data) || !data[0]?.generated_text) {
      return res.json({
        completion: null,
        error: "Invalid response format from API",
      });
    }

    let completion = data[0].generated_text.substring(solution.length);

    // Remove any content after code block
    const codeBlockEnd = completion.indexOf("```");
    if (codeBlockEnd !== -1) {
      completion = completion.substring(0, codeBlockEnd);
    }

    // Check trailing whitespace if specified
    if (trailingWhitespace) {
      if (completion.startsWith(trailingWhitespace)) {
        return res.json({
          completion: completion.substring(trailingWhitespace.length),
          error: null,
        });
      } else {
        return res.json({
          completion: null,
          error: null,
        });
      }
    }

    // Return completion without whitespace check
    return res.json({
      completion,
      error: null,
    });
  } catch (error) {
    console.error("Error in code completion:", error);
    return res.status(500).json({
      completion: null,
      error: "Internal server error during code completion",
    });
  }
});

// Existing static file routes
app.use("/api/examples/*", (req, res, next) => {
  const filename = req.params[0];
  req.url = filename;
  express.static(path.join(__dirname, "..", "Projects"))(req, res, next);
});

app.use("/api/manifest/*", (req, res, next) => {
  const project = req.params[0];
  req.url = "lake-manifest.json";
  express.static(path.join(__dirname, "..", "Projects", project))(
    req,
    res,
    next
  );
});

app.use("/api/toolchain/*", (req, res, next) => {
  const project = req.params[0];
  req.url = "lean-toolchain";
  express.static(path.join(__dirname, "..", "Projects", project))(
    req,
    res,
    next
  );
});

// Using the client files
app.use(express.static(path.join(__dirname, "..", "client", "dist")));
app.use(nocache());

let server;
if (crtFile && keyFile) {
  var privateKey = fs.readFileSync(keyFile, "utf8");
  var certificate = fs.readFileSync(crtFile, "utf8");
  var credentials = { key: privateKey, cert: certificate };

  const PORT = process.env.PORT ?? 443;
  server = https
    .createServer(credentials, app)
    .listen(PORT, () => console.log(`HTTPS on port ${PORT}`));

  // redirect http to https
  express().get("*", function (req, res) {
    res.redirect("https://" + req.headers.host + req.url).listen(80);
  });
} else {
  const PORT = process.env.PORT ?? 8080;
  server = app.listen(PORT, () => console.log(`HTTP on port ${PORT}`));
}

const wss = new WebSocketServer({ server });

function startServerProcess(project) {
  let projectPath = __dirname + `/../Projects/` + project;

  let serverProcess;
  if (isDevelopment) {
    console.warn("Running without Bubblewrap container!");
    serverProcess = cp.spawn("lean", ["--server"], { cwd: projectPath });
  } else {
    console.info("Running with Bubblewrap container.");
    serverProcess = cp.spawn("./bubblewrap.sh", [projectPath], {
      cwd: __dirname,
    });
  }

  serverProcess.stderr.on("data", (data) =>
    console.error(`Lean Server: ${data}`)
  );

  serverProcess.on("error", (error) =>
    console.error(`Launching Lean Server failed: ${error}`)
  );

  serverProcess.on("close", (code) => {
    console.log(`lean server exited with code ${code}`);
  });

  return serverProcess;
}

wss.addListener("connection", function (ws, req) {
  const urlRegEx = /^\/websocket\/([\w.-]+)$/;
  const reRes = urlRegEx.exec(req.url);
  if (!reRes) {
    console.error(`Connection refused because of invalid URL: ${req.url}`);
    return;
  }
  const project = reRes[1];

  const ip = anonymize(
    req.headers["x-forwarded-for"] || req.socket.remoteAddress
  );
  const ps = startServerProcess(project);

  const socket = {
    onMessage: (cb) => {
      ws.on("message", cb);
    },
    onError: (cb) => {
      ws.on("error", cb);
    },
    onClose: (cb) => {
      ws.on("close", cb);
    },
    send: (data, cb) => {
      ws.send(data, cb);
    },
  };
  const reader = new rpc.WebSocketMessageReader(socket);
  const writer = new rpc.WebSocketMessageWriter(socket);
  const socketConnection = jsonrpcserver.createConnection(reader, writer, () =>
    ws.close()
  );
  const serverConnection = jsonrpcserver.createProcessStreamConnection(ps);
  socketConnection.forward(serverConnection, (message) => {
    return message;
  });
  serverConnection.forward(socketConnection, (message) => {
    return message;
  });

  ws.on("close", () => {
    console.log(`[${new Date()}] Socket closed - ${ip}`);
    socketCounter -= 1;
  });

  socketConnection.onClose(() => serverConnection.dispose());
  serverConnection.onClose(() => socketConnection.dispose());

  console.log(`[${new Date()}] Socket opened - ${ip}`);
  socketCounter += 1;
  logStats();
});
