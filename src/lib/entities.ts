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
  identity?: { role?: string; name?: string; full_name?: string; first_name?: string; last_name?: string; email?: string; phone?: string; birthday?: string | number };
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

export function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
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
