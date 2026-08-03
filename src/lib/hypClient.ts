// ─── HYP Pay API client ────────────────────────────────────────────────────
//
// Thin wrappers around https://pay.hyp.co.il/p/ (docs: developers.hyp.co.il/pay).
// All calls are server-to-server only — HYP requires these never be called from
// a browser or mobile app. Every response uses HTTP 200 even on logical failure;
// callers must always check the `CCode` field (0 = success).
//
// Credentials come from Lambda environment variables, sourced from Secrets
// Manager at deploy time — same pattern as GMAIL_APP_PASSWORD in sendOtp.ts.
// The original used Firebase's defineSecret(); there is no code-level
// equivalent needed here since env vars are already lazily read per-call.
//
// The full credential set (Masof + KEY + PassP — each HYP terminal is its
// own complete registration, not a shared KEY/PassP with a swappable
// Masof) can also be switched live from the Admin Portal's System Config
// screen — PK='APPCONFIG' SK='PAYMENT_TERMINAL' holds a list of known
// terminals plus which one is active. Falls back to the HYP_MASOF/HYP_KEY/
// HYP_PASSP env vars whenever that config item is missing, has no active
// terminal selected, the active terminal is missing a field, or the
// lookup itself fails — a DynamoDB hiccup must never be able to block real
// payment processing. Storing KEY/PassP in DynamoDB (readable by any admin
// with portal access) is a deliberate tradeoff for live-switchability;
// see the System Config screen's own warning about this.

import { GetCommand } from '@aws-sdk/lib-dynamodb';
import iconv from 'iconv-lite';
import { ddb, TABLE_NAME } from './dynamo';

const HYP_BASE_URL = 'https://pay.hyp.co.il/p/';

// HYP's hosted-page backend is a legacy Windows system that renders free-text
// fields (client name, product Info) in the Windows-1255 Hebrew codepage,
// not UTF-8, despite their docs only saying "URL-encode normally" — sending
// standard UTF-8 percent-encoding for Hebrew text here (what URLSearchParams
// does by default) came through on HYP's own hosted page as unrenderable
// boxes/question marks, since HYP decoded our UTF-8 bytes as windows-1255
// and found no valid character mapping. Only applied when the value actually
// contains non-ASCII text, so plain English names are unaffected.
const FREE_TEXT_FIELDS = new Set(['ClientName', 'ClientLName', 'Info']);

function hasNonAscii(value: string): boolean {
  return /[^\x00-\x7F]/.test(value);
}

function encodeWindows1255(value: string): string {
  const bytes = iconv.encode(value, 'windows-1255');
  let out = '';
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9\-_.~]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

interface HypCredentials {
  masof: string;
  key: string;
  passP: string;
}

interface PaymentTerminalConfig {
  activeTerminalId?: string;
  terminals?: { id: string; label: string; masof: string; key: string; passP: string }[];
}

async function getActiveTerminalOverride(): Promise<Partial<HypCredentials> | null> {
  try {
    const res = await ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: 'APPCONFIG', SK: 'PAYMENT_TERMINAL' },
    }));
    const config = res.Item as PaymentTerminalConfig | undefined;
    const active = config?.terminals?.find((t) => t.id === config.activeTerminalId);
    if (!active) return null;
    return { masof: active.masof || undefined, key: active.key || undefined, passP: active.passP || undefined };
  } catch (err) {
    console.error('[hypClient] PAYMENT_TERMINAL lookup failed, falling back to HYP_MASOF/HYP_KEY/HYP_PASSP:', err);
    return null;
  }
}

async function getHypCredentials(): Promise<HypCredentials> {
  const override = await getActiveTerminalOverride();
  return {
    masof: override?.masof ?? (process.env.HYP_MASOF as string),
    key: override?.key ?? (process.env.HYP_KEY as string),
    passP: override?.passP ?? (process.env.HYP_PASSP as string),
  };
}

// ─── Response parsing ──────────────────────────────────────────────────────
// HYP responses are URL-encoded query strings (e.g. "CCode=0&Id=123&...").

function parseHypResponse(body: string): Record<string, string> {
  const trimmed = body.trim().replace(/^\?/, '');
  const params = new URLSearchParams(trimmed);
  const result: Record<string, string> = {};
  for (const [k, v] of params.entries()) result[k] = v;
  return result;
}

async function callHyp(params: Record<string, string | number | boolean>): Promise<{ raw: string; fields: Record<string, string> }> {
  const url = new URL(HYP_BASE_URL);
  const rawPairs: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (FREE_TEXT_FIELDS.has(k) && typeof v === 'string' && hasNonAscii(v)) {
      rawPairs.push(`${k}=${encodeWindows1255(v)}`);
    } else {
      url.searchParams.set(k, String(v));
    }
  }
  const finalUrl = rawPairs.length ? `${url.toString()}${url.search ? '&' : '?'}${rawPairs.join('&')}` : url.toString();
  const response = await fetch(finalUrl, { method: 'GET' });
  const raw = await response.text();
  return { raw, fields: parseHypResponse(raw) };
}

function ccodeOf(fields: Record<string, string>): number {
  const n = Number(fields.CCode);
  return Number.isFinite(n) ? n : -1;
}

// ─── Email receipt (SendHesh) ──────────────────────────────────────────────
// HYP auto-generates and emails a tax invoice/receipt when SendHesh=True is
// sent alongside a valid `email`. Callers opt in per request via
// `sendReceipt` — real purchases/renewals want one, but the ₪1 card-update-
// only token capture (createHypCardUpdatePage.ts) deliberately never opts
// in, since there's no real transaction for the customer to be invoiced for.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function receiptParams(email: string | undefined, sendReceipt: boolean | undefined): { SendHesh: 'True' } | Record<string, never> {
  if (!sendReceipt) return {};
  if (!email || !EMAIL_RE.test(email)) {
    console.warn('[hypClient] sendReceipt requested but no valid email on file — skipping SendHesh, checkout continues');
    return {};
  }
  return { SendHesh: 'True' };
}

// ─── action=APISign&What=SIGN — create a hosted payment page ─────────────

export interface CreatePaymentPageParams {
  order: string;
  amount: number;
  tash: number;
  // Only meaningful when tash > 1 — 1 = standard (no-interest) installments,
  // 6 = credit. See ChargeTokenParams for the equivalent on the token-charge
  // path; both rely on HYP/the card issuer to split the charge, never us.
  tashType?: number;
  clientName: string;
  clientLName?: string;
  email?: string;
  cell?: string;
  userId: string;
  info?: string;
  pageLang?: 'HEB' | 'ENG';
  // See receiptParams() above — opts into HYP emailing an automatic invoice.
  sendReceipt?: boolean;
}

export class HypSignError extends Error {
  constructor(public readonly ccode: number, public readonly fields: Record<string, string>) {
    super(`HYP SIGN failed: CCode=${ccode} ${JSON.stringify(fields)}`);
  }
}

export async function createHypSignedPaymentUrl(params: CreatePaymentPageParams): Promise<string> {
  const creds = await getHypCredentials();

  const { raw, fields } = await callHyp({
    action: 'APISign',
    What: 'SIGN',
    Sign: 'True',
    Masof: creds.masof,
    KEY: creds.key,
    PassP: creds.passP,
    Amount: params.amount,
    Order: params.order,
    ClientName: params.clientName,
    ...(params.clientLName ? { ClientLName: params.clientLName } : {}),
    ...(params.email ? { email: params.email } : {}),
    ...(params.cell ? { cell: params.cell } : {}),
    ...(params.info ? { Info: params.info } : {}),
    ...receiptParams(params.email, params.sendReceipt),
    UserId: params.userId,
    Tash: params.tash,
    ...(params.tash > 1 ? { TashType: params.tashType ?? 1 } : {}),
    Coin: 1,
    PageLang: params.pageLang ?? 'HEB',
  });

  if (fields.action !== 'pay' || !fields.signature) {
    throw new HypSignError(ccodeOf(fields), fields);
  }

  return `${HYP_BASE_URL}?${raw.trim().replace(/^\?/, '')}`;
}

// ─── action=APISign&What=VERIFY — confirm a redirect's authenticity ──────

export async function verifyHypTransaction(redirectParams: Record<string, string>): Promise<{ verified: boolean; fields: Record<string, string> }> {
  const creds = await getHypCredentials();
  const { fields } = await callHyp({
    action: 'APISign',
    What: 'VERIFY',
    Masof: creds.masof,
    KEY: creds.key,
    PassP: creds.passP,
    ...redirectParams,
  });
  return { verified: ccodeOf(fields) === 0, fields };
}

// ─── action=getToken — capture an opaque card token after a successful charge ─

export interface HypToken {
  token: string;
  expiryMonth: number;
  expiryYear: number;
}

export async function getHypToken(transId: string): Promise<HypToken | null> {
  const creds = await getHypCredentials();
  const { fields } = await callHyp({ action: 'getToken', Masof: creds.masof, PassP: creds.passP, TransId: transId });

  console.log(`[getHypToken] transId=${transId} raw fields:`, JSON.stringify(fields));

  if (ccodeOf(fields) !== 0 || !fields.Token) return null;

  const tokef = fields.Tokef ?? '';
  const yy = Number(tokef.slice(0, 2));
  const mm = Number(tokef.slice(2, 4));
  if (!Number.isFinite(yy) || !Number.isFinite(mm)) return null;

  return { token: fields.Token, expiryMonth: mm, expiryYear: 2000 + yy };
}

// ─── action=soft&Token=True — charge a previously captured token ─────────

export interface ChargeTokenParams {
  token: string;
  expiryMonth: number;
  expiryYear: number;
  amount: number;
  userId: string;
  clientName: string;
  info: string;
  email?: string;
  // HYP-native installment sale: pass the FULL amount above plus these two —
  // HYP itself splits the charge across `tash` payments with the card
  // issuer; we never send less than the full amount nor charge again later.
  // tashType 1 = standard (no-interest) installments, 6 = credit.
  tash?: number;
  tashType?: number;
  // See receiptParams() above — opts into HYP emailing an automatic invoice.
  sendReceipt?: boolean;
}

export interface ChargeTokenResult {
  success: boolean;
  ccode: number;
  transactionId?: string;
  authCode?: string;
}

export async function chargeHypToken(params: ChargeTokenParams): Promise<ChargeTokenResult> {
  const creds = await getHypCredentials();
  const yy = String(params.expiryYear % 100).padStart(2, '0');
  const mm = String(params.expiryMonth).padStart(2, '0');

  const { fields } = await callHyp({
    action: 'soft',
    Masof: creds.masof,
    PassP: creds.passP,
    Token: 'True',
    CC: params.token,
    Tmonth: mm,
    Tyear: yy,
    Amount: params.amount,
    UserId: params.userId,
    ClientName: params.clientName,
    Info: params.info,
    ...(params.email ? { email: params.email } : {}),
    ...receiptParams(params.email, params.sendReceipt),
    ...(params.tash && params.tash > 1 ? { Tash: params.tash, TashType: params.tashType ?? 1 } : {}),
  });

  const ccode = ccodeOf(fields);
  return { success: ccode === 0, ccode, transactionId: fields.Id, authCode: fields.ACode };
}

// ─── action=zikoyAPI — refund a previous transaction (full or partial) ───

export interface RefundResult {
  success: boolean;
  ccode: number;
  refundTransactionId?: string;
}

export async function refundHypTransaction(transId: string, amount: number): Promise<RefundResult> {
  const creds = await getHypCredentials();
  const { fields } = await callHyp({ action: 'zikoyAPI', Masof: creds.masof, PassP: creds.passP, TransId: transId, Amount: amount });
  const ccode = ccodeOf(fields);
  return { success: ccode === 0, ccode, refundTransactionId: fields.Id };
}

// ─── inquireTransactions — card brand lookup (HYP "Enterprise"/CG product) ─
//
// A completely separate HYP product: its own endpoint, its own
// user/password/terminalNumber login (NOT Masof/KEY/PassP), and an XML
// request/response body. Used purely to look up a charge's card brand for
// display — never for charging. Missing credentials safely no-op (returns
// null) rather than throwing.

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch] as string));
}

export async function inquireCardBrand(tranId: string): Promise<string | null> {
  const url = process.env.HYP_ENTERPRISE_URL;
  const user = process.env.HYP_ENTERPRISE_USER;
  const password = process.env.HYP_ENTERPRISE_PASSWORD;
  const terminal = process.env.HYP_ENTERPRISE_TERMINAL;
  if (!url || !user || !password || !terminal || !tranId) return null;

  const xmlPayload =
    '<ashrait><request><version>2000</version><language>ENG</language>' +
    '<command>inquireTransactions</command><inquireTransactions>' +
    `<terminalNumber>${escapeXml(terminal)}</terminalNumber>` +
    `<tranId>${escapeXml(tranId)}</tranId>` +
    '</inquireTransactions></request></ashrait>';

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ int_in: xmlPayload, user, password }).toString(),
    });
    const raw = await response.text();

    const { XMLParser } = await import('fast-xml-parser');
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(raw) as Record<string, any>;
    const inquire = parsed?.ashrait?.response?.inquireTransactions;
    const txns = inquire?.transactions?.transaction;
    const tx = Array.isArray(txns) ? txns[0] : txns;
    const brand = tx?.creditCompany;
    const brandName = typeof brand === 'object' && brand !== null ? brand['#text'] : brand;

    return typeof brandName === 'string' && brandName.trim() ? brandName.trim() : null;
  } catch (err: any) {
    console.error(`[inquireCardBrand] lookup failed for tranId=${tranId}:`, err);
    return null;
  }
}
