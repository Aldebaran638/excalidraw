import "./ChatIconButton.scss";

import type { ButtonHTMLAttributes, ReactNode } from "react";

/** Shared, labelled actions for chat and its application previews. */
export const ChatIconButton = ({
  label,
  icon,
  active = false,
  primary = false,
  className = "",
  type = "button",
  buttonRef,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  buttonRef?: import("react").Ref<HTMLButtonElement>;
  label: string;
  icon: ReactNode;
  active?: boolean;
  primary?: boolean;
}) => (
  <button
    {...props}
    ref={buttonRef}
    type={type}
    className={`chat-icon-button ${active ? "is-active" : ""} ${
      primary ? "is-primary" : ""
    } ${className}`}
    aria-label={label}
    data-tooltip={label}
  >
    <span aria-hidden="true">{icon}</span>
  </button>
);
