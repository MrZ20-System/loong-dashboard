import type { ChangedFileEntry } from "@loongboard/contracts";
import "./change-file-icon.css";

export type ChangeFileTone = "added" | "removed" | "modified";

export function changeFileTone(
  changeType: ChangedFileEntry["changeType"],
): ChangeFileTone {
  if (changeType === "added") return "added";
  if (changeType === "removed") return "removed";
  return "modified";
}

export function changeFileLabel(
  changeType: ChangedFileEntry["changeType"],
): string {
  if (changeType === "added") return "Added";
  if (changeType === "removed") return "Deleted";
  return "Modified";
}

export function ChangeFileIcon({
  changeType,
  className,
}: {
  changeType: ChangedFileEntry["changeType"];
  className?: string;
}) {
  const tone = changeFileTone(changeType);
  return (
    <span
      className={`change-file-icon change-file-icon--${tone}${className ? ` ${className}` : ""}`}
      aria-hidden="true"
    >
      <span className="change-file-icon__fold" />
      <span className="change-file-icon__mark">
        {tone === "added" ? "+" : tone === "removed" ? "−" : "±"}
      </span>
    </span>
  );
}
