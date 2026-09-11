import { message } from "../../i18n";

export const repositoryMessages = {
  syncStarted: message("Sync started.", "同步已开始。"),
  syncFailed: message("Sync failed: {detail}", "同步失败：{detail}"),
  startingSync: message("Starting sync…", "正在启动同步…"),
  syncNow: message("Sync now", "立即同步"),
  checkingSyncStatus: message("Checking sync status…", "正在检查同步状态…"),
  syncStatusUnavailable: message(
    "Sync status unavailable: {detail}",
    "同步状态不可用：{detail}",
  ),
  initialSyncLastDays: message(
    "Initial sync · last {days} days",
    "首次同步 · 最近 {days} 天",
  ),
  syncingRepositoryUpdates: message("Syncing repository updates…", "正在同步仓库更新…"),
  syncingLatestUpdates: message("Syncing latest updates…", "正在同步最新更新…"),
  initialSyncFailed: message("Initial sync failed", "首次同步失败"),
  initialSyncFailedLastDays: message(
    "Initial sync failed · last {days} days",
    "首次同步失败 · 最近 {days} 天",
  ),
  lastSyncFailed: message("Last sync failed", "上次同步失败"),
  lastComplete: message("last complete {value}", "最近一次完整同步：{value}"),
  noCompleteSync: message("no complete sync", "尚无完整同步"),
  syncIdle: message("Sync idle", "同步空闲"),
  synced: message("Synced {value}", "已同步 {value}"),
  awaitingFirstComplete: message("Awaiting first complete sync", "等待首次完整同步"),
  justNow: message("just now", "刚刚"),
  minutesAgo: message("{minutes}m ago", "{minutes} 分钟前"),
  syncStatus: message("{repositoryId} sync status", "{repositoryId} 同步状态"),
};
