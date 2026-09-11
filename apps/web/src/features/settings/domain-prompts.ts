import type { LocalizedMessage } from "../../i18n";

/** The two product-owned variants of the Domain update instruction.
 *
 * User-saved prompt text is never generated from this catalog.  These values
 * are only offered as an explicit draft replacement in the settings page.
 */
export const DOMAIN_UPDATE_PROMPT: LocalizedMessage = {
  en: `# Update domains

Analyze the repository and update the Domain definitions in the JSON file for this repository.

Keep the definitions useful for deterministic changed-file classification. Edit the JSON file directly, preserve useful existing metadata, and explain the changes in this conversation.`,
  "zh-CN": `# 更新领域

分析此仓库，并更新该仓库 JSON 文件中的领域定义。

保持这些定义适合对变更文件进行确定性分类。直接编辑 JSON 文件，保留有用的现有元数据，并在本次对话中说明所做的变更。`,
};
