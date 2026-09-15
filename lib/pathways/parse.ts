// feeder_middle_school 文本解析：清洗（去括号备注）、分割（/、）、升学方式识别。
// 纯函数，无 IO，供迁移脚本与单测使用。匹配 schools 的逻辑在迁移脚本内（需 DB）。
export type AdmissionMode = "assign" | "placement" | "direct" | "partial" | "unknown";

export const ADMISSION_MODE_LABELS: Record<AdmissionMode, string> = {
  assign: "对口",
  placement: "派位",
  direct: "直升",
  partial: "部分对口",
  unknown: "待识别",
};

/** 去掉全角/半角括号备注：`田林三中（部分对口）/中国中学（部分对口）` → `田林三中/中国中学` */
export function cleanFeederText(text: string): string {
  return text.replace(/（[^）]*）/g, "").replace(/\([^)]*\)/g, "");
}

/** 按 `/`、`、`（全角逗号）切分候选初中名 */
export function splitCandidates(text: string): string[] {
  return text
    .split(/[\/、]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 按整行原始文本识别升学方式（优先级：直升 > 派位 > 部分对口 > 对口 > 待识别） */
export function detectAdmissionMode(text: string): AdmissionMode {
  if (text.includes("直升")) return "direct";
  if (text.includes("派位")) return "placement";
  if (text.includes("部分对口")) return "partial";
  if (text.includes("对口")) return "assign";
  return "unknown";
}

export type ParsedFeederRow = {
  primaryName: string;
  rawText: string;
  admissionMode: AdmissionMode;
  candidates: string[];
};

export function parseFeederRow(primaryName: string, rawText: string): ParsedFeederRow {
  return {
    primaryName,
    rawText,
    admissionMode: detectAdmissionMode(rawText),
    candidates: splitCandidates(cleanFeederText(rawText)),
  };
}
