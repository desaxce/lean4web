import { useState, useRef, useEffect } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faPaperPlane, faPlus } from "@fortawesome/free-solid-svg-icons";

interface MessageComposerProps {
  onSubmit: (message: string) => void;
  placeholder?: string;
  className?: string;
}

export const MessageComposer = ({
  onSubmit,
  placeholder = "Paste your problem statement in Markdown/LaTeX here.",
  className = "",
}: MessageComposerProps) => {
  const [message, setMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea as content grows
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [message]);

  const handleSubmit = async () => {
    if (!message.trim()) return;

    setIsLoading(true);
    try {
      await onSubmit(message);
    } finally {
      setIsLoading(false);
      setMessage("");
    }
  };

  return (
    <div className={`message-composer ${className}`}>
      <div className="message-composer-container">
        <textarea
          ref={textareaRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={placeholder}
          rows={1}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
        />

        <button
          onClick={handleSubmit}
          disabled={isLoading || !message.trim()}
          className="send-button"
        >
          <FontAwesomeIcon icon={faPaperPlane} />
        </button>
      </div>
    </div>
  );
};

export default MessageComposer;
