// Shared constants for the admin-portal-only endpoints (adminGetLambdaLogs,
// adminQueryTableItems, adminGetS3UploadUrl, etc). Kept in one place so the
// allowlists below are easy to audit/extend without hunting through each
// handler.

// Functions the Lambda Logs Viewer screen can query. Deliberately a curated
// subset, not all ~140 functions — these are the ones an admin actually
// needs to debug in production (booking/payment critical path + the
// reactive Streams consumers). Add a key here to expose a new function in
// the viewer; no Terraform change needed since IAM below is already scoped
// to every incore-* log group.
export const ADMIN_LOG_VIEWER_FUNCTIONS = [
  'bookClass',
  'cancelBooking',
  'joinWaitlist',
  'swapClass',
  'hypPaymentCallback',
  'createHypPaymentPage',
  'createHypTokenPurchase',
  'adminRunHypBillingCycle',
  'adminGrantMembership',
  'sendOtp',
  'submitRegistrationForm',
  'processMail',
  'onClassBookingChanged',
  'chargeHypBillingAgreements',
] as const;

// Mirrors lambdas.tf's function_name transform exactly:
//   function_name = "incore-${lower(replace(each.key, "/([A-Z])/", "-$1"))}"
// so the log group name computed here always matches the real deployed
// Lambda without needing a Describe/list round-trip.
export function functionKeyToLogGroup(functionKey: string): string {
  const kebab = functionKey.replace(/([A-Z])/g, '-$1').toLowerCase();
  return `/aws/lambda/incore-${kebab}`;
}

// PK prefixes the DynamoDB Table Data Viewer's JSON editor may NOT write or
// delete through the generic adminUpdateTableItem/adminDeleteTableItem
// endpoints — every one of these already has a dedicated admin* handler
// that enforces invariants a raw item overwrite would silently break
// (Cognito sync on MEMBER#, capacity/waitlist counters on CLASS#, billing
// state on ORDER#/AGREEMENT#). Viewing is always allowed; only writes are
// blocked. Extend this list before extending the generic editor to a new
// entity type with its own invariants.
export const TABLE_EDITOR_RESTRICTED_PREFIXES = ['MEMBER#', 'ORDER#', 'AGREEMENT#', 'CLASS#'];

export function isRestrictedForGenericEdit(pk: string): boolean {
  return TABLE_EDITOR_RESTRICTED_PREFIXES.some((prefix) => pk.startsWith(prefix));
}

// SK values under the shared PK='APPCONFIG' partition (see
// getPaymentPolicySettings.ts / getCancellationPolicySettings.ts /
// saveSupportSettings.ts for the pre-existing members of this family) that
// adminSaveSystemConfig is allowed to write. Keeps the generic config save
// endpoint from being usable to plant an arbitrary unrelated item under
// PK='APPCONFIG'.
export const EDITABLE_APPCONFIG_KEYS = [
  'PAYMENT_POLICY',
  'CANCELLATION_POLICY',
  'SUPPORT_SETTINGS',
  'PAYMENT_TERMINAL',
  'FEATURE_FLAGS',
  'SYSTEM_NOTIFICATION',
] as const;

// S3 key prefixes admins may upload into via adminGetS3UploadUrl — separate
// allowlist from getUploadUrl.ts's ALLOWED_PREFIXES because those are
// member-owned-path prefixes gated by "path contains caller's own uid",
// which doesn't apply to admin-authored assets like product photos.
export const ADMIN_UPLOAD_PREFIXES = ['product-images/', 'class-images/', 'documents/', 'forca-extra-training/', 'medical-clearances/'];
