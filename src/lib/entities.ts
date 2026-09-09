// Shared single-table entity shapes and pure date helpers used by more than
// one function. See src/functions/bookClass.ts for the full key-design notes.

export interface ClassItem {
  PK: string; SK: string;
  date: string; // ISO 8601
  capacity: number;
  currentAttendeesCount: number;
  // Firestore stored either a plain string or a DocumentReference to resolve
  // a class-type name; DynamoDB has no reference type, so this is always a
  // plain, already-resolved string here.
  className?: string;
  isWaitlistEnabled?: boolean;
  waitlist?: WaitlistEntry[];
  // Only ever set together, and only when isPrivate is true — see
  // validatePrivateFields(). A private class is filtered out of getClasses.ts
  // and 404s from getClassDetail.ts/bookClass.ts for anyone not in
  // allowedMemberIds (and not already registered, and not an admin).
  isPrivate?: boolean;
  allowedMemberIds?: string[];
}

// Shared validation for the isPrivate/allowedMemberIds pair, used by
// createClass.ts, updateClass.ts, and saveClassSeries.ts so the three
// writers don't each reimplement the same rules slightly differently.
//
// `currentAllowedMemberIds` is the existing item's list (undefined on
// create) — used as a fallback when an update sends isPrivate: true without
// also sending a fresh allowedMemberIds array (e.g. an admin toggling other
// fields on an already-private class).
export function validatePrivateFields(
  isPrivate: boolean,
  rawAllowedMemberIds: unknown,
  capacity: number,
  currentAllowedMemberIds?: string[],
): { ok: true; allowedMemberIds: string[] } | { ok: false; error: string } {
  if (!isPrivate) return { ok: true, allowedMemberIds: [] };

  const providedIds = Array.isArray(rawAllowedMemberIds)
    ? rawAllowedMemberIds.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map(v => v.trim())
    : null;
  const allowedMemberIds = Array.from(new Set(providedIds ?? currentAllowedMemberIds ?? []));

  if (allowedMemberIds.length === 0) return { ok: false, error: 'missing_allowed_member_ids' };
  if (allowedMemberIds.length > capacity) return { ok: false, error: 'allowed_members_exceed_capacity' };
  return { ok: true, allowedMemberIds };
}

export interface WaitlistEntry {
  member: string; // memberId — plain string, not a Firestore-style reference
  since: string; // ISO 8601
  status: 'waiting' | 'pending' | 'expired' | 'declined';
  pendingSince?: string; // ISO 8601
}

// PK=TEMPLATE#<templateId>  SK=METADATA — direct lookup by id (used by
// sendTemplateBroadcast, which blasts one admin-picked template regardless
// of type).
// GSI1PK=TEMPLATETYPE#<type> GSI1SK=TEMPLATE#<templateId> — lookup by type
// (used by resolveTemplate, which resolves "the" template for an event kind
// like CLASS_CANCEL). Two independent access patterns on the same entity.
export interface NotificationTemplateItem {
  PK: string; SK: string;
  templateId: string;
  type: string;
  titleHe: string;
  titleEn: string;
  bodyHe: string;
  bodyEn: string;
  bgColor: string;
  textColor: string;
}

export interface RegistrationItem {
  PK: string; SK: string;
  userId: string;
  classId: string;
  classDate: string; // ISO 8601, denormalized from ClassItem.date at booking time
  status: string;
  consumedFrom: string;
  membershipId: string;
  targetMonth: string;
  weekKey?: string;
  adminCardId?: string;
  reminderSent?: boolean;
  reminderSentAt?: string;
  // Denormalized display name for trial (guest) registrations, i.e.
  // consumedFrom === 'TRIAL' — those have no MemberProfileItem to resolve a
  // name from. See getClassMembers.ts.
  fullName?: string;
}

export interface MembershipItem {
  PK: string; SK: string;
  membershipId: string;
  status: string;
  targetMonth: string;
  isAutoRenew: boolean;
  monthlyLimit: number;
  weeklyLimit: number;
  allowedLegalCancellationsPerMonth: number;
  usage: { totalMonthlyUsed: number; legalCancellationsUsed: number; lateCancellationsUsed: number };
  weeklyUsage: Record<string, number>;
  // Admin manual balance nudge (+/-), applied on top of monthlyLimit without
  // touching the contracted total or usage history — see getEffectiveMonthlyLimit.
  manualAdjustment?: number;
  type?: string; // 'CUSTOM_MIGRATION' for admin-manual migration memberships
  // Only meaningfully populated for CUSTOM_MIGRATION items today (see
  // adminGrantCustomMigration.ts) — a custom-duration bridge's real
  // start/end, independent of the calendar month it's filed under.
  startDate?: string;
  endDate?: string;
  weeklyProcessed?: Record<string, boolean>;
  monthEndProcessed?: Record<string, boolean>;
}

// PK=INQUIRY#<id>  SK=METADATA
// GSI1PK=MEMBER#<uid> GSI1SK=INQUIRY#<createdAtIso>#<id> — a member's own
// inquiries list (ClientSupportScreen/ClientTabsScreen's unread badge).
export interface SupportInquiryItem {
  PK: string; SK: string;
  status: 'OPEN' | 'CLOSED';
  userId?: string;
  userDisplayName?: string;
  userEmail?: string;
  subject?: string;
  lastMessage?: string;
  lastMessageAt?: string;
  lastSender?: 'member' | 'admin';
  createdAt?: string;
}

// PK=INQUIRY#<id>  SK=MESSAGE#<messageId>
export interface SupportInquiryMessageItem {
  PK: string; SK: string;
  sender: 'member' | 'admin' | 'system';
  text: string;
  isAutoReply?: boolean;
  messageKey?: string;
  createdAt?: string;
}

// PK=MAIL#<id>  SK=METADATA — ephemeral: written to trigger an email send,
// deleted immediately after (see processMail.ts).
export interface MailItem {
  PK: string; SK: string;
  to: string;
  message: { subject?: string; html?: string };
}

// PK=MEMBER#<uid>  SK=CANCEL#<classId>
export interface CancellationItem {
  PK: string; SK: string;
  classId: string;
  status: 'LEGALLY_CANCELLED' | 'LATE_CANCELLED' | 'ADMIN_CANCELLED';
  consumedFrom: string;
  membershipId: string;
  adminCardId?: string | null;
  weekKey?: string | null;
  targetMonth: string;
  cancelledAt: string; // ISO 8601
  cancellationReason?: string | null;
  adminCancelled?: boolean;
  adminReverted?: boolean;
  revertedAt?: string;
}

// PK=MEMBER#<uid>  SK=PROFILE
// GSI1PK="ROLE#admin" GSI1SK=MEMBER#<uid> — set only when role/identity.role is 'admin'.
// GSI3PK=EMAIL#<email> GSI3SK=MEMBER#<uid> — set whenever email is known, for
// pre-login lookups (e.g. the forgot-password OTP flow in otp.ts).
export interface MemberProfileItem {
  PK: string; SK: string;
  name?: string;
  email?: string;
  role?: string;
  // 'parent_only' — created solely to hold Family Accounts links (adminCreateUser.ts's
  // accountType field), no membership/booking of their own. Undefined/'member' is
  // the default, ordinary trainee account. See listMyFamily.ts/switchProfile.ts.
  // brand — which framework (INCORE studio vs FORCA military prep) this member
  // belongs to, set once at creation from the admin's active Backoffice toggle
  // (adminCreateUser.ts). Lives only here, never denormalized onto memberships/
  // registrations/orders — those are filtered by joining back to this field via
  // the member id. Undefined ⇒ treat as 'incore' (pre-FORCA legacy members).
  identity?: { role?: string; name?: string; full_name?: string; first_name?: string; last_name?: string; email?: string; phone?: string; birthday?: string | number; accountType?: 'member' | 'parent_only'; brand?: 'incore' | 'forca' };
  phone?: string;
  birthday?: string | number;
  // S3 object key (incore_uploads is fully private, see s3.tf) for the
  // member's profile photo — resolved to a short-lived presigned URL by
  // getProfile.ts, never stored/returned as a raw fetchable URL.
  photoKey?: string;
  device?: { expo_push_token?: string; expoPushToken?: string };
  expoPushToken?: string;
  // Legacy array mirrored alongside the individual PunchCardItem entities
  // below — kept in sync because the client (StoreScreen) still reads it
  // directly. See functions/src/products.ts grantPunchCard/autoGrantProduct.
  extra?: { punch_cards: unknown[] };
  membership?: Record<string, unknown>;
  preferredLanguage?: string;
  forms?: {
    health_form?: boolean;
    health_declaration?: {
      id_number?: string;
      submitted_at?: string;
      name?: string;
      answers?: Record<string, unknown>;
      // S3 object keys (incore_uploads is fully private, see s3.tf) — NOT
      // directly-fetchable URLs. Resolve to a short-lived viewable URL via
      // getFileUrl.ts when actually displaying the file.
      pdf_key?: string;
      doctor_approval_key?: string;
    };
    registration_form?: boolean;
    registration_answers?: Record<string, unknown>;
    agreedToPolicies?: boolean;
    policiesAcceptedAt?: string;
    policyVersion?: string;
    medicalInfoConsent?: boolean;
    healthFormConfirm?: boolean;
    marketingConsent?: boolean;
    // Adult members' own photo-consent toggle (ProfileScreen). Under-18
    // members use parental_consent.photoConsent instead — see getProfile.ts.
    photo_consent?: boolean;
    parental_consent?: {
      isApproved?: boolean;
      parentName?: string;
      parentPhone?: string;
      parentEmail?: string;
      signatureKey?: string; // S3 object key — see health_declaration comment above
      signaturePaths?: string[];
      photoConsent?: boolean;
      signedAt?: string;
      expiresAt?: string;
    };
  };
  payment?: {
    hypToken?: string;
    hypTokenExpiryMonth?: number;
    hypTokenExpiryYear?: number;
    hypTokenProductId?: string;
    hypTokenUpdatedAt?: string;
    hasSavedCard?: boolean;
    cardBrand?: string;
    payment_count?: number;
  };
  pending_membership?: { type?: string };
  admin?: {
    alertMessage?: string;
    hasUnreadAlert?: boolean;
    require_health_form?: boolean;
    require_registration_form?: boolean;
    forceShowPaymentButton?: boolean;
  };
  subscriptionStatus?: string;
  subscriptionExpiryAlertSent?: string;
}

// Same fallback chain as getProfile.ts's `name` resolution — identity.name,
// then identity.first_name+last_name, then the top-level (new-profile) name
// field. Members migrated from the old Firestore shape only have identity.*
// populated, so skipping straight to profile.name (as several notification
// call sites used to) silently resolves to an empty string instead of
// falling back.
export function deriveMemberName(profile: MemberProfileItem): string {
  const id = profile.identity;
  if (id?.name) return id.name;
  if (id?.full_name) return id.full_name;
  const first = id?.first_name ?? '';
  const last = id?.last_name ?? '';
  if (first || last) return `${first} ${last}`.trim();
  return profile.name ?? '';
}

export interface ComplianceFlags {
  requiresRegistrationForm: boolean;
  requiresHealthDeclaration: boolean;
  requiresPoliciesAgreement: boolean;
}

// Shared by getProfile.ts (self/admin lookup) and listMyFamily.ts (a
// parent's own linked-children listing) — same logic, computed once so a
// FORCA parent can see which of her linked daughters still need forms
// without an extra getProfile round-trip per child.
export function computeComplianceFlags(profile: MemberProfileItem): ComplianceFlags {
  const role = profile.identity?.role ?? profile.role ?? 'member';
  const forms = profile.forms ?? {};
  const admin = profile.admin ?? {};

  const registrationFormFilled = forms.registration_form === true;
  const requiresRegistrationForm = admin.require_registration_form === true && !registrationFormFilled;

  const hdSubmittedAt = forms.health_declaration?.submitted_at;
  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  const requiresHealthDeclaration = role !== 'admin' && admin.require_health_form === true
    && (!hdSubmittedAt || new Date(hdSubmittedAt) < twoYearsAgo);

  const requiresPoliciesAgreement = role !== 'admin' && forms.agreedToPolicies !== true;

  return { requiresRegistrationForm, requiresHealthDeclaration, requiresPoliciesAgreement };
}

// PK=ALERT#<id>  SK=METADATA
// GSI1PK='ALERT' GSI1SK=<createdAtIso>#<id> — reverse-chronological feed for
// the admin portal's dashboard (adminGetSystemAlerts). Written via
// recordSystemAlert() (lib/alerts.ts) either from a handler's own
// failure branch, or automatically by processDlqMessage.ts whenever an
// async Lambda invocation (EventBridge-scheduled function) exhausts its
// retries and lands on the DLQ (see dlq.tf) — source is 'dlq:<functionName>'
// for those. TTL'd after 30 days like other ephemeral items on this table.
export interface SystemAlertItem {
  PK: string; SK: string;
  GSI1PK: string; GSI1SK: string;
  severity: 'warning' | 'error' | 'critical';
  source: string; // originating function name, e.g. 'hypPaymentCallback' or 'dlq:chargeHypBillingAgreements'
  message: string;
  context?: Record<string, unknown>;
  createdAt: string; // ISO 8601
  expiresAtEpoch: number;
}

// PK=ORDER#<orderId>  SK=METADATA
// GSI1PK=MEMBER#<uid> GSI1SK=ORDER#<createdAtIso>#<orderId> — per-member,
// chronological (adminRefundMemberLastPayment's "most recent completed order").
// GSI2PK="ORDER" GSI2SK=<createdAtIso>#<orderId> — global chronological
// listing (adminListHypOrders).
export type HypOrderStatus = 'pending' | 'completed' | 'failed' | 'refunded';
export type HypProductType = 'subscription' | 'mid_month' | 'punch_card' | 'single_ticket';
export type HypPaymentMethod = 'one_time' | 'direct_debit';

export interface HypOrderItem {
  PK: string; SK: string;
  // Queried by adminListHypOrders.ts's GSI2PK='ORDER' scan for the All
  // Transactions admin screen — set at creation (orderFromBuild) and never
  // touched again, so status/refund updates elsewhere stay indexed.
  GSI2PK: string;
  GSI2SK: string;
  orderId: string;
  userId: string;
  status: HypOrderStatus;
  createdAt: string;
  updatedAt: string;
  amount: number;
  productId: string;
  productName: string;
  // Denormalized from ProductItem.description at order-creation time (same
  // reasoning as productName) — used to build the "Info" string sent to HYP.
  description?: string;
  productType: HypProductType;
  paymentMethod: HypPaymentMethod;
  targetMonth?: string;
  startDate?: string;
  endDate?: string;
  monthlyLimit?: number;
  weeklyLimit?: number;
  allowedLegalCancellationsPerMonth?: number;
  sessions?: number;
  // Set only for productType punch_card/single_ticket — the PunchCardItem
  // (PK=MEMBER#<userId>, SK=PUNCHCARD#<punchCardId>) that grantPunchCardSessions
  // created for this order, so a later refund can find and reverse it. Orders
  // completed before this field existed have no link and can't be
  // auto-reversed on refund.
  punchCardId?: string;
  totalPayments: number;
  amountPerCharge?: number;
  totalAmount?: number;
  // Set only for a HYP-native installment sale (Tash/TashType) charged in one
  // shot via createHypTokenPurchase — installmentsCount/installmentAmount are
  // the same numbers as totalPayments/amountPerCharge, kept as separate named
  // fields since HYP itself (not our own cron) collects the later payments.
  installmentsCount?: number;
  installmentAmount?: number;
  hypTransactionId?: string;
  hypCCode?: number;
  verifiedAt?: string;
  billingAgreementId?: string;
  isCardUpdateOnly?: boolean;
  refundedAmount?: number;
  refundedAt?: string;
  refundedBy?: string;
}

// PK=AGREEMENT#<agreementId>  SK=METADATA
// GSI1PK=MEMBER#<uid> GSI1SK=AGREEMENT#<kind>#<agreementId> — per-member open
// agreements (card-update eligibility check, stale-agreement supersession,
// token-refresh cascade, adminClearMemberSavedCard).
// GSI2PK="AGREEMENT" GSI2SK=<createdAtIso>#<agreementId> — global chronological
// listing (adminListHypBillingAgreements).
// GSI3PK="AGREEMENT_STATUS#active" GSI3SK=<nextChargeDateIso> — ONLY present
// while status==='active' AND nextChargeDate is set; this is what the daily
// billing cron queries. Removed (not just changed) on pause/cancel/complete/
// give-up so the item drops out of the index instead of needing a status
// filter over an unbounded query.
export type HypAgreementStatus = 'active' | 'paused' | 'cancelled' | 'completed' | 'failed';
export type HypAgreementKind = 'subscription' | 'store_installment';

export interface HypBillingAgreementItem {
  PK: string; SK: string;
  agreementId: string;
  userId: string;
  status: HypAgreementStatus;
  kind: HypAgreementKind;
  productId: string;
  productName: string;
  // Same reasoning as HypOrderItem.description — denormalized so recurring
  // charges (chargeOneAgreement) can build the "Info" string without an
  // extra live product lookup on every renewal.
  description?: string;
  token: string;
  tokenExpiryMonth: number;
  tokenExpiryYear: number;
  amountPerCharge: number;
  totalAmount?: number;
  // Same numbers as amountPerCharge/totalPayments, present only on a
  // HYP-native Tash installment sale — see HypOrderItem for why these are
  // kept as distinct named fields instead of reusing the existing ones.
  installmentsCount?: number;
  installmentAmount?: number;
  totalPayments: number;
  paymentsCompleted: number;
  nextChargeDate?: string;
  targetMonth?: string;
  consecutiveFailures: number;
  sourceOrderId: string;
  // Set only when this agreement was created by bridgeTokenToBillingAgreement
  // (hypBillingAgreements.ts) instead of a real checkout — i.e. it reuses a
  // token saved by some other order rather than one captured for this plan.
  // sourceOrderId is 'BRIDGED' (no real order backs it) whenever this is set.
  bridgedFrom?: 'pending_membership' | 'active_membership';
  lastChargeResult?: { at: string; ccode: number; hypTransactionId: string | null; success: boolean };
  // Set the first time a "no card on file" charge attempt notifies admins —
  // that failure mode retries daily forever (unlike a real decline, which
  // gives up after 2 tries), so this gates it to a single admin push instead
  // of paging them every night until the member adds a card.
  noCardAdminNotified?: boolean;
  createdAt: string;
  updatedAt: string;
}

// PK=PRODUCT#<id>  SK=METADATA
// Backs both the client Store (StoreScreen — punch_card/single_ticket/
// mid_month) and the admin Membership plan manager (AllMembershipsScreen —
// type==='subscription') — one entity, two client-side view shapes
// (Product vs Membership) mapped in adminMembershipsQuery.ts/useProducts.ts.
export interface ProductItem {
  PK: string; SK: string;
  active: boolean;
  sessions?: number;
  type?: string;
  name?: string;
  description?: string;
  price?: number;
  installments?: number;
  monthlyLimit?: number;
  weeklyLimit?: number;
  sessions_per_week?: number;
  allowedLegalCancellationsPerMonth?: number;
  is_public?: boolean;
  assigned_to?: string[];
  // GROUPS targeting: visibility mode + subscription-type Product IDs to target
  // when visibility === 'GROUPS'. is_public/assigned_to stay the source of
  // truth for legacy readers; these are additive.
  visibility?: 'PUBLIC' | 'PRIVATE' | 'GROUPS';
  target_group_ids?: string[];
  expires_at?: string | null;
  productImageUrl?: string;
  // Admin Membership-plan-manager-only fields (unused by the Store).
  popular?: boolean;
  priority_book?: boolean;
  allowed_class_ids?: string[];
  createdAt?: string;
}

export interface WalletItem {
  PK: string; SK: string;
  extraPunches: number;
}

// PK=MEMBER#<parentUid>  SK=FAMILY#<childUid>
// GSI1PK=MEMBER#<childUid> GSI1SK=FAMILYOF#<parentUid> — reverse lookup
// ("who is this member's parent"), used by adminLinkFamilyMember.ts to
// enforce one-parent-per-child and by switchProfile.ts-adjacent checks.
// childName is a denormalized display hint only, set at link time — never
// trusted as source of truth; adminListFamilyLinks.ts/listMyFamily.ts
// re-resolve names live from the child's own MemberProfileItem.
export interface FamilyLinkItem {
  PK: string; SK: string;
  GSI1PK: string; GSI1SK: string;
  linkId: string;
  parentUid: string;
  childUid: string;
  childName?: string;
  status: 'active';
  createdAt: string;
  createdBy: string;
}

// PK=SWITCHNONCE#<childUid>  SK=NONCE#<nonceId>
// Ephemeral, single-use secret driving the CUSTOM_AUTH challenge flow that
// lets switchProfile.ts obtain a linked child's real Cognito tokens without
// ever knowing their password — see cognitoCreateAuthChallenge.ts /
// cognitoVerifyAuthChallengeResponse.ts. TTL'd via the table's existing
// expiresAtEpoch attribute; consumed synchronously within one switchProfile
// invocation, so a short window is enough.
export interface SwitchNonceItem {
  PK: string; SK: string;
  nonceId: string;
  parentUid: string;
  childUid: string;
  secret: string;
  consumed: boolean;
  createdAt: string;
  expiresAtEpoch: number;
}

// PK=CAMPAIGN#<monthId>  SK=METADATA  (monthId = "YYYY-MM")
export interface BirthdayCampaignItem {
  PK: string; SK: string;
  giftTitle?: string;
  giftValue?: number;
  giftExpiryDays?: number | null;
  rewardedUsers?: string[];
}

export interface PunchCardItem {
  PK: string; SK: string;
  cardId: string;
  remainingPunches: number;
  expiryDate: string | null; // ISO 8601
  notes: string;
  source: string;
}

// A PENDING grant (see adminGrantCustomMigration.ts) is usable as soon as
// the class itself falls within its start/end window, even before the
// nightly activatePendingMemberships cron flips status to ACTIVE — waiting
// for the cron would otherwise block booking a class that's clearly within
// the paid-for window just because "today" is still before startDate.
export function isMembershipUsableForClass(m: MembershipItem, classDate: Date): boolean {
  if (m.status === 'ACTIVE') return true;
  if (m.status === 'PENDING' && m.startDate && classDate >= new Date(m.startDate)) {
    return !m.endDate || classDate <= new Date(m.endDate);
  }
  return false;
}

export function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function getEffectiveMonthlyLimit(m: MembershipItem): number {
  return m.monthlyLimit + (m.manualAdjustment ?? 0);
}

export function computeWeekKey(date: Date): string {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function israelDateStr(date: Date): string {
  return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

/** Last millisecond of the last day of the month containing `date`. */
export function endOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
}

/** One month later, same time-of-day. */
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

/** 00:00 on the 1st of the month following `from`. */
export function firstOfNextMonth(from: Date): Date {
  return new Date(from.getFullYear(), from.getMonth() + 1, 1, 0, 0, 0, 0);
}
