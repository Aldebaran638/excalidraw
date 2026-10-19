import { Footer } from "@excalidraw/excalidraw/index";
import React from "react";

import { Button } from "@excalidraw/excalidraw/components/Button";

import { isExcalidrawPlusSignedUser } from "../app_constants";

import { DebugFooter, isVisualDebuggerEnabled } from "./DebugCanvas";
import { EncryptedIcon } from "./EncryptedIcon";

export const AppFooter = React.memo(
  ({
    onChange,
    onChatOpen,
  }: {
    onChange: () => void;
    onChatOpen: () => void;
  }) => {
    return (
      <Footer>
        <div
          style={{
            display: "flex",
            gap: ".5rem",
            alignItems: "center",
          }}
        >
          {isVisualDebuggerEnabled() && <DebugFooter onChange={onChange} />}
          {!isExcalidrawPlusSignedUser && <EncryptedIcon />}
          <Button
            onSelect={onChatOpen}
            style={{ width: "auto", padding: "0 12px", minHeight: 36 }}
            aria-label="打开笔记聊天"
          >
            笔记聊天
          </Button>
        </div>
      </Footer>
    );
  },
);
