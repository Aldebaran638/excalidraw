import Spinner from "@excalidraw/excalidraw/components/Spinner";
import {
  LoadIcon,
  RetryIcon,
  checkIcon,
  save,
} from "@excalidraw/excalidraw/components/icons";
import { t } from "@excalidraw/excalidraw/i18n";

import "./RepositorySyncStatus.scss";

import type {
  RepositorySyncStatus as SyncStatus,
  RepositoryLoadFailure,
} from "../hooks/useRepositoryNoteSync";

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

export const RepositorySyncStatus = ({
  status,
  loadFailure,
  onRetry,
  retrying = false,
}: {
  status: SyncStatus;
  loadFailure?: RepositoryLoadFailure | null;
  onRetry?: () => void;
  retrying?: boolean;
}) => {
  const content = contentForStatus(status);
  const label = loadFailure
    ? status === "conflict"
      ? "恢复待确认，自动保存已暂停"
      : loadFailure.kind === "missing"
      ? "文件未找到，自动保存已暂停"
      : "读取失败，自动保存已暂停"
    : content.label;
  return (
    <div
      className={`RepositorySyncStatus RepositorySyncStatus--${status}`}
      role="status"
      aria-live="polite"
      aria-label={label}
      title={
        loadFailure
          ? status === "conflict"
            ? `${loadFailure.name} 已恢复读取。请选择保留当前画布为副本，或加载文件版本。`
            : `${loadFailure.name}：${loadFailure.message}。当前画布已保留，不会自动新建笔记。`
          : label
      }
    >
      <span className="RepositorySyncStatus__icon" aria-hidden="true">
        {content.icon}
      </span>
      <span className="RepositorySyncStatus__label">{label}</span>
      {loadFailure && onRetry && status !== "conflict" && (
        <button
          type="button"
          className="RepositorySyncStatus__retry"
          disabled={retrying}
          onClick={onRetry}
        >
          {retrying ? "读取中…" : "重试读取"}
        </button>
      )}
    </div>
  );
};
