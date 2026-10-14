import Spinner from "@excalidraw/excalidraw/components/Spinner";
import {
  LoadIcon,
  RetryIcon,
  checkIcon,
  save,
} from "@excalidraw/excalidraw/components/icons";
import { t } from "@excalidraw/excalidraw/i18n";

import "./RepositorySyncStatus.scss";

import type { RepositorySyncStatus as SyncStatus } from "../hooks/useRepositoryNoteSync";

const contentForStatus = (status: SyncStatus) => {
  switch (status) {
    case "pending":
      return { icon: save, label: t("repositorySync.pending") };
    case "syncing":
      return {
        icon: <Spinner size="1rem" />,
        label: t("repositorySync.syncing"),
      };
    case "synced":
      return { icon: checkIcon, label: t("repositorySync.synced") };
    case "external":
      return { icon: LoadIcon, label: t("repositorySync.external") };
    case "missing":
      return { icon: RetryIcon, label: t("repositorySync.missing") };
    case "error":
      return { icon: RetryIcon, label: t("repositorySync.error") };
    case "conflict":
      return { icon: RetryIcon, label: "本地文件有更新，请处理冲突" };
    case "unavailable":
      return { icon: RetryIcon, label: "本地笔记服务不可用" };
    case "unbound":
      return { icon: save, label: t("repositorySync.unbound") };
  }
};

export const RepositorySyncStatus = ({ status }: { status: SyncStatus }) => {
  const content = contentForStatus(status);
  return (
    <div
      className={`RepositorySyncStatus RepositorySyncStatus--${status}`}
      role="status"
      aria-live="polite"
      aria-label={content.label}
      title={content.label}
    >
      <span className="RepositorySyncStatus__icon" aria-hidden="true">
        {content.icon}
      </span>
      <span className="RepositorySyncStatus__label">{content.label}</span>
    </div>
  );
};
