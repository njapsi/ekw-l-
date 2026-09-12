/**
 * The `reports` module (operator's "Phase 11"). Turns the other modules'
 * analyses into professional, exportable reports with a fixed seven-section
 * layout (Executive Summary · Key Metrics · Problems · Opportunities ·
 * Recommendations · Priority Actions · Historical Changes).
 *
 * A finished report is an **immutable snapshot** (ADR-0026): the dashboard view
 * and every export (PDF / CSV / JSON) render from it, so historical reports
 * never change. Public share links serve a **redacted** snapshot only.
 */
export {
  REPORT_TYPES,
  REPORT_TYPE_LABEL,
  REPORT_TYPE_BLURB,
  type ReportTypeKey,
  type ReportSnapshot,
  type ReportType,
} from './schemas.js';
export { buildReportSnapshot, type BuildSnapshotResult } from './build.js';
export {
  generateReport,
  deleteReport,
  type GenerateReportInput,
  type GenerateReportResult,
} from './generate.js';
export { generateReportJob } from './jobs.js';
export {
  listReports,
  getReport,
  getReportForShare,
  reportTypeAvailability,
  type ReportListItem,
  type ReportDetail,
  type PublicReport,
  type TypeAvailability,
} from './read.js';
export { createShareLink, revokeShareLink, shareLinkActive, type ShareLinkView } from './share.js';
export { redactSnapshotForPublic, scrubText } from './redact.js';
export {
  renderExport,
  exportFilename,
  snapshotToCsv,
  snapshotToPdf,
  type ExportFormat,
  type RenderedExport,
} from './export/index.js';
