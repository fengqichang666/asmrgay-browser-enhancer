import type { NodeType } from "./graph.js";

const MEDIA_EXTENSIONS = /\.(?:mp3|m4a|wav|flac|ogg|mp4|mkv|webm|avi|jpg|jpeg|png|gif|zip|7z|rar|pdf)$/i;

export interface ClassificationSignals {
  isDirectory: boolean;
  name: string;
  childCount?: number;
  hasPagination?: boolean;
  hasMediaElement?: boolean;
}

export function classifyEntry(signals: ClassificationSignals): NodeType {
  if (signals.isDirectory) return "directory";
  if (signals.hasMediaElement || MEDIA_EXTENSIONS.test(signals.name)) return "content";
  if ((signals.childCount ?? 0) > 0 || signals.hasPagination) return "directory";
  return "content";
}
