import { useState } from "react";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { RetryIcon, CloseIcon } from "@excalidraw/excalidraw/components/icons";

import { chatImageURL } from "../data/chatImages";

import { ChatIconButton } from "./ChatIconButton";

import type { ChatImageRef } from "../data/chatImages";

export function ChatImage({
  noteId,
  sessionId,
  image,
}: {
  noteId: string;
  sessionId: string;
  image: ChatImageRef;
}) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const url = `${chatImageURL(noteId, sessionId, image.id)}?attempt=${attempt}`;
  return (
    <div className="chat-image">
      {failed ? (
        <div className="chat-image-error" role="status">
          图片读取失败，消息已保留
          <ChatIconButton
            label="重新加载图片"
            icon={RetryIcon}
            onClick={() => {
              setFailed(false);
              setAttempt(attempt + 1);
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          className="chat-image-thumbnail"
          aria-label={`放大图片：${image.name}`}
          onClick={() => setOpen(true)}
        >
          <img
            src={url}
            alt={image.name}
            width={image.width}
            height={image.height}
            onError={() => setFailed(true)}
          />
        </button>
      )}
      {open && (
        <Dialog
          title={image.name}
          className="chat-image-preview-dialog"
          size="wide"
          onCloseRequest={() => setOpen(false)}
        >
          <ChatIconButton
            label="关闭图片"
            icon={CloseIcon}
            className="chat-image-close"
            onClick={() => setOpen(false)}
          />
          <div className="chat-image-dialog">
            <img src={url} alt={image.name} onError={() => setFailed(true)} />
          </div>
        </Dialog>
      )}
    </div>
  );
}
