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
  groupId?: string;
  // FORCA training-session-only fields (see createTrainingSession.ts) —
  // groupId is the FORCA Group this session was created for; getCoachAccess()
  // (lib/coachAccess.ts) scopes every coach-gated endpoint against it.
  // trainingTypeId points at the TrainingTypeItem this session was created
  // for (optional — a session can be untyped); equipmentTaken is what the
  // coach has currently checked out for this specific session — each entry's
  // quantity is the neededQuantity computed at check-out time (custom, or
  // per_member resolved against this session's exact allowedMemberIds
  // count), stored rather than re-derived so a later change to the group's
  // size or the training type's mode doesn't silently change how much
  // returnSessionEquipment.ts hands back. equipmentReturnedAt is set once
  // she logs everything back — see toggleSessionEquipment.ts /
  // returnSessionEquipment.ts, both of which nudge that EquipmentItem's
  // outCount up/down by the stored quantity, not a flat 1.
  trainingTypeId?: string;
  equipmentTaken?: { equipmentId: string; quantity: number }[];
  equipmentReturnedAt?: string;
  // Stamped once checkUnreturnedEquipmentAlerts.ts has raised a SystemAlertItem
  // for this session's still-outstanding equipment — prevents re-alerting on
  // every hourly run for the same session.
  equipmentAlertSentAt?: string;
  location?: string;
  // Denormalized at creation time (see createTrainingSession.ts /
  // getCoachOptions.ts) rather than resolved by id on read — a coach lives
  // in the FORCA table but an admin only exists in the INCORE table, so
  // there's no single dual-table "resolve this uid's name" helper the way
  // resolveMemberProfile() covers trainees; storing the name once at
  // creation avoids needing one.
  coachId?: string;
  coachName?: string;
  // Set only on instances generated from a RecurringSessionItem template
  // (see adminSaveRecurringSession.ts) — instances from the older one-off/
  // repeat_weekly flow (repeat_weekly/series_id above) have no template and
  // leave this unset; both kinds coexist and behave identically everywhere
  // except the templates list, which only shows the former.
  recurringSessionId?: string;
  // Set once the assigned coach (or admin) marks the session done — see
  // closeSession.ts. Requires every roster entry to have actualAttendance
  // recorded and equipmentTaken to be empty (everything returned) first.
  // After this is set, markActualAttendance.ts/toggleSessionEquipment.ts/
  // returnSessionEquipment.ts all refuse further coach edits — only admin
  // can still change anything (same unrestricted override she already has
  // everywhere else, e.g. getTrainingHistory.ts's corrections).
  closedAt?: string;
  closedBy?: string;
}

// PK=RECURRINGSESSION#<id>  SK=METADATA
// FORCA-only, persistent "this is our recurring Tuesday 18:00 session"
// definition an admin sets up in Settings (see adminSaveRecurringSession.ts)
// — deliberately date-less; concrete dated ClassItem instances are a derived
// byproduct, generated through the end of the current calendar month (same
// cap createTrainingSession.ts's client-side repeat-weekly loop already
// accepted) and tagged with this item's id via ClassItem.recurringSessionId.
// Editing dayOfWeek/time/groupId (the pattern itself) deletes and regenerates
// every not-yet-occurred instance; editing trainingTypeId/coachId/coachName/
// location patches them in place — see lib/sessionInstance.ts's
// deleteFutureInstances(). Past instances are never touched either way;
// they're the historical record getTrainingHistory.ts reads.
export interface RecurringSessionItem {
  PK: string; SK: string;
  groupId: string;
  trainingTypeId: string;
  coachId?: string;
  coachName?: string;
  dayOfWeek: number; // 0=Sunday..6=Saturday
  time: string; // "HH:mm", 24h, Asia/Jerusalem — same convention as israelDateStr()
  location?: string;
  active: boolean;
  createdAt: string;
  createdBy: string;
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
  // FORCA training-session attendance — createTrainingSession.ts sets both
  // at auto-registration time (declaredAttendance always starts 'pending').
  // declareAttendance.ts is the trainee's own write path (self only, see its
  // ownership check); markActualAttendance.ts is the coach's (or admin's)
  // separate write action. Undefined on every ordinary INCORE registration.
  declaredAttendance?: 'pending' | 'yes' | 'no';
  // Optional free-text reason, only meaningful when declaredAttendance === 'no'.
  declineReason?: string;
  actualAttendance?: 'present' | 'absent' | null;
}

// PK=GROUP#<id>  SK=METADATA
// FORCA-only, persistent training cohort — a trainee is assigned to at most
// one via identity.groupId. createTrainingSession.ts scans for members with
// a given groupId and auto-registers all of them, uncapped — see
// adminSaveGroup.ts. FORCA has no separate membership-plan concept the way
// INCORE does (ProductItem) — a Group doubles as that: it carries the same
// name/description/price/sessionsPerWeek shape a membership plan would.
export interface GroupItem {
  PK: string; SK: string;
  name: string;
  description?: string;
  price?: number;
  sessionsPerWeek?: number;
  createdAt: string;
  createdBy: string;
}

// A single equipment requirement on a TrainingTypeItem — 'custom' is a
// fixed quantity the admin types in (e.g. "always 2 stopwatches, however
// many trainees"); 'per_member' scales with how many members are actually
// registered for a given session (createTrainingSession.ts auto-registers
// every current Group member, so that count is known exactly per session —
// see getCoachSessions.ts's neededQuantity calculation). customQuantity is
// only read when mode is 'custom'.
export interface TrainingTypeEquipmentRequirement {
  equipmentId: string;
  mode: 'custom' | 'per_member';
  customQuantity?: number;
}

// PK=TRAININGTYPE#<id> SK=METADATA — FORCA's equivalent of INCORE's
// ClassType (see adminSaveClassType.ts), extended with a duration and a set
// of required-equipment entries (picked from the Manage > Equipment list).
// FORCA-only, lives in the FORCA table exclusively.
export interface TrainingTypeItem {
  PK: string; SK: string;
  name: string;
  durationMinutes?: number;
  equipmentRequirements?: TrainingTypeEquipmentRequirement[];
  createdAt: string;
  createdBy: string;
}

// PK=EQUIPMENT#<id> SK=METADATA — FORCA's gear inventory: admin tracks how
// many of each item exist (quantity) and how many units are currently
// checked out and not yet back (outCount, 0..quantity) — a partial return
// (e.g. 3 of 5 ropes taken, only 2 back) shows as outCount=1, not a single
// all-or-nothing flag. Not a per-session checkout log — one running count
// per equipment item, adjusted manually. TrainingTypeItem.equipmentRequirements
// references these. FORCA-only, lives in the FORCA table exclusively.
export interface EquipmentItem {
  PK: string; SK: string;
  name: string;
  quantity: number;
  outCount: number;
  createdAt: string;
  createdBy: string;
}

// PK=EXTRATRAINING#<id> SK=METADATA — FORCA's admin-managed "Extra Training"
// content library: out-of-class videos/PDFs trainees can browse on their
// own time (distinct from a scheduled Training Session — see
// createTrainingSession.ts). fileKey is an S3 object key under
// forca-extra-training/ (see ADMIN_UPLOAD_PREFIXES in lib/adminConfig.ts),
// resolved to a short-lived signed URL on read by getExtraTraining.ts, never
// stored/returned as a raw fetchable URL. FORCA-only, lives in the FORCA
// table exclusively.
export interface ExtraTrainingItem {
  PK: string; SK: string;
  title: string;
  description?: string;
  category?: string;
  contentType: 'video' | 'pdf';
  fileKey: string;
  createdAt: string;
  createdBy: string;
}

// A single purchasable variant (size/color/etc) on a MerchProductItem — the
// admin free-types the label ("S", "Red / M", ...) rather than picking from
// a rigid size×color matrix, same flexibility as
// TrainingTypeItem.equipmentRequirements. stock is decremented at payment
// time by lib/merchStock.ts, never client-writable directly.
export interface MerchVariant {
  id: string;
  label: string;
  stock: number;
}

// PK=MERCHPRODUCT#<id>  SK=METADATA — FORCA's sellable physical merchandise
// (shirts, hoodies, water bottles), a deliberately separate entity from
// ProductItem (INCORE's subscription/punch-card Store) rather than an
// extension of it — ProductItem has no variant/stock concept and is already
// overloaded across two view shapes (Product vs Membership); adding a third,
// very different one (images/variants/inventory) would only make that
// worse. imageKeys are S3 object keys under product-images/<id>/... —
// resolved to short-lived signed URLs on every read (adminListMerchProducts.ts /
// getForcaMerchProducts.ts), never stored/returned as raw/public URLs, same
// convention as ExtraTrainingItem.fileKey above. active gates the
// client-facing list only — draft (false) products stay admin-only, e.g.
// while composing/previewing before publishing. FORCA-only, lives in the
// FORCA table exclusively.
export interface MerchProductItem {
  PK: string; SK: string;
  name: string;
  description?: string;
  price: number;
  imageKeys: string[];
  variants: MerchVariant[];
  active: boolean;
  createdAt: string;
  createdBy: string;
}

// PK=MERCHORDER#<orderId>  SK=METADATA
// GSI1PK=MEMBER#<uid> GSI1SK=MERCHORDER#<createdAtIso>#<orderId> — a
// member's own purchase history.
// GSI2PK='MERCHORDER' GSI2SK=<createdAtIso>#<orderId> — global chronological
// listing, ready for a future admin transactions view; same convention as
// HypOrderItem's own GSI2, not itself built out in this pass.
//
// Deliberately NOT a HypOrderItem — that entity/table (TABLE_NAME, the
// INCORE table) backs 100% of INCORE's live payment processing, and HYP's
// success-redirect URL is one fixed merchant-portal setting shared by both
// brands (confirmed: createHypSignedPaymentUrl's SIGN request has no
// per-transaction callback param), so hypPaymentCallback.ts is unavoidably
// still the single entry point every HYP redirect lands on. Keeping merch
// orders in their own FORCA-table entity, created by createMerchPaymentPage.ts
// and completed by lib/merchPayments.ts's handleMerchOrderCallback()
// (dispatched from a single early orderId-prefix branch in
// hypPaymentCallback.ts — see its own comment), means every line of
// merch-specific logic lives in new code that live INCORE checkout never
// executes, rather than threading brand-awareness through the existing
// subscription/installment/billing-agreement machinery in hypOrders.ts.
// orderId is always generated as `merch-<uuid>` — see newMerchOrderKey() —
// precisely so that dispatch branch can tell orders apart without a DB
// lookup first.
//
// items is a list, not a single product/variant, so "Buy Now" (a one-entry
// list) and a cart checkout (an N-entry list) are the same order shape —
// see createMerchPaymentPage.ts. quantity/unitPrice are denormalized at
// order-creation time and never recomputed from live catalog prices later,
// same reasoning as every other denormalized name/price field in this file.
export interface MerchOrderLineItem {
  merchProductId: string;
  merchProductName: string;
  merchVariantId: string;
  merchVariantLabel: string;
  quantity: number;
  unitPrice: number;
}

export interface MerchOrderItem {
  PK: string; SK: string;
  GSI1PK: string; GSI1SK: string;
  GSI2PK: string; GSI2SK: string;
  orderId: string;
  userId: string;
  status: 'pending' | 'completed' | 'failed' | 'refunded';
  items: MerchOrderLineItem[];
  amount: number;
  hypTransactionId?: string;
  hypCCode?: number;
  createdAt: string;
  updatedAt: string;
  verifiedAt?: string;
  refundedAmount?: number;
  refundedAt?: string;
  refundedBy?: string;
}

// ─── FORCA Tracker (exercises + tests/quizzes) ─────────────────────────────
// FORCA-only, lives in the FORCA table exclusively. See adminSaveExercise.ts /
// adminSaveTestDefinition.ts.

export type ExerciseMeasurementType = 'weight_reps' | 'reps_only' | 'time' | 'band_level' | 'bodyweight_reps';

// PK=EXERCISE#<id>  SK=METADATA
// Admin-defined exercise catalog — mirrors TrainingTypeItem's shape.
// measurementType drives which fields of ExerciseLogEntryItem.value a
// trainee's log entry actually fills in; bandLevels is only meaningful
// when measurementType === 'band_level' (admin-typed labels, e.g.
// "Light"/"Medium"/"Heavy" — no fixed universal scale).
export interface ExerciseDefinitionItem {
  PK: string; SK: string;
  name: string;
  measurementType: ExerciseMeasurementType;
  bandLevels?: string[];
  active: boolean;
  createdAt: string;
  createdBy: string;
}

// PK=EXERCISELOG#<id>  SK=METADATA
// GSI1PK=MEMBER#<uid> GSI1SK=EXERCISELOG#<exerciseId>#<loggedAt>#<id> — a
// member's own logged history for one exercise, sorted by date (a
// begins_with query on `EXERCISELOG#<exerciseId>#` scopes to just that
// exercise; the bare GSI1PK alone gets everything she's ever logged).
// measurementType is denormalized from the definition at log time so a
// later change to the exercise's own measurementType never reinterprets
// old entries.
export interface ExerciseLogEntryItem {
  PK: string; SK: string;
  GSI1PK: string; GSI1SK: string;
  userId: string;
  exerciseId: string;
  exerciseName: string;
  measurementType: ExerciseMeasurementType;
  value: {
    weight?: number;
    reps?: number;
    timeSeconds?: number;
    bandLevel?: string;
  };
  loggedAt: string;
  createdAt: string;
}

// PK=TESTDEF#<id>  SK=METADATA
// Admin-defined recurring test/quiz (בחנים) series — e.g. a fitness test
// scored in seconds (lower is better) or in reps (higher is better).
// higherIsBetter is what lets adminGetTestResults.ts's per-entry
// changeVsPrevious comparison work correctly for either direction.
export interface TestDefinitionItem {
  PK: string; SK: string;
  name: string;
  unit?: string;
  higherIsBetter: boolean;
  active: boolean;
  createdAt: string;
  createdBy: string;
}

// PK=TESTRESULT#<id>  SK=METADATA
// GSI1PK=MEMBER#<uid> GSI1SK=TESTRESULT#<testDefId>#<instanceNumber padded>#<id>
// — a member's results for one test, in instance order. Admin-recorded only
// (see adminRecordTestResult.ts) — "Only the admin views the test results"
// means this is an evaluation record, not a trainee self-log, unlike
// ExerciseLogEntryItem above. instanceNumber and the up/down comparison are
// both computed per (member, testDef) pair, not globally — "improvement or
// decline" is about this trainee's own trend, not a squad-wide ranking.
export interface TestResultItem {
  PK: string; SK: string;
  GSI1PK: string; GSI1SK: string;
  userId: string;
  testDefId: string;
  testDefName: string;
  instanceNumber: number;
  score: number;
  date: string;
  createdAt: string;
  createdBy: string;
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
  // identity.role — 'admin' | 'coach' | 'member' (undefined). 'coach' is
  // FORCA-only — access is now granular (see lib/coachAccess.ts's
  // getCoachAccess()) rather than the old single on/off isCoachOrAdmin gate.
  // identity.groupId — a FORCA trainee's assigned Group (GroupItem, see
  // adminSaveGroup.ts) — the unit createTrainingSession.ts auto-registers.
  // identity.groupIds — a COACH's assigned Groups (plural, distinct field
  // from a trainee's singular groupId) — getCoachAccess() scopes every
  // coach-gated endpoint to only these groups' sessions/rosters. Deny-by-
  // default: undefined/empty means the coach sees nothing until an admin
  // assigns at least one group.
  // identity.coachPermissions — per-action read/write, deny-by-default when
  // unset. Only 'attendance' has a real write action (marking actual
  // attendance) — 'performance'/'healthDeclarations' are read-only concepts
  // today (no performance data/UI exists yet; a coach never edits a
  // trainee's health declaration), so they don't have a 'write' state.
  identity?: {
    role?: string; name?: string; full_name?: string; first_name?: string; last_name?: string;
    email?: string; phone?: string; birthday?: string | number;
    accountType?: 'member' | 'parent_only'; brand?: 'incore' | 'forca';
    groupId?: string;
    groupIds?: string[];
    coachPermissions?: {
      attendance: 'none' | 'read' | 'write';
      performance: 'none' | 'read';
      healthDeclarations: 'none' | 'read';
    };
  };
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

/**
 * How far Asia/Jerusalem's wall clock is ahead of UTC, in minutes, at the
 * given instant (+120 in winter, +180 during DST) — computed via Intl
 * rather than hardcoded so it stays correct across Israel's DST transitions.
 */
function israelOffsetMinutes(atUtc: Date): number {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(atUtc)) parts[p.type] = p.value;
  // Some ICU implementations render midnight as "24" with hour12: false.
  const asIfUtcMs = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
  );
  return (asIfUtcMs - atUtc.getTime()) / 60000;
}

/**
 * The inverse of israelDateStr(): given a calendar date + time-of-day
 * expressed as Israel wall-clock (year, 0-indexed month, day, hour, minute),
 * returns the real UTC instant it represents. Needed because AWS Lambda's
 * runtime clock is UTC (no TZ env var configured — see eventbridge.tf's
 * cron jobs, which set schedule_expression_timezone explicitly instead of
 * relying on process TZ) — the plain `new Date(y, m, d, h, min)`
 * constructor silently interprets those numbers in the *server's* local
 * timezone (UTC) rather than Israel's, off by Israel's UTC+2/+3 offset.
 * See lib/sessionInstance.ts's upcomingOccurrences() for the bug this fixes.
 */
export function israelWallTimeToDate(year: number, month0: number, day: number, hour: number, minute: number): Date {
  const guessUtcMs = Date.UTC(year, month0, day, hour, minute, 0, 0);
  const offsetMin = israelOffsetMinutes(new Date(guessUtcMs));
  return new Date(guessUtcMs - offsetMin * 60000);
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
