import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, FORCA_TABLE_NAME } from '../dynamo';
import type { MemberProfileItem } from '../entities';
import { notifyAdmins } from '../adminNotify';
import { getEmailBrandTokens } from '../emailBranding';
import { sendEmail } from '../mailer';
import { getExpoPushToken, sendExpoPushBatch } from '../push';
import { CHANNEL_LABEL, CHOICE_LABEL, EARLY_LEGAL_FLAG, fillTemplate, formatIsraelDateTime } from './rules';

/** "בקשתך לביטול השתתפות התקבלה" or, for a medical freeze, "הודעתך על הקפאה רפואית התקבלה". */
export const confirmationTitle = (r: Pick<RequestReceipt, 'type'>) =>
  (r.type === 'medical_freeze' ? 'הודעתך על הקפאה רפואית התקבלה' : 'בקשתך לביטול השתתפות התקבלה');
import type { RequestReceipt } from './store';

// Who hears about a request:
//  - the parent: the confirmation text Or set, as a push, an in-app message
//    (MESSAGE# on her profile, same as the card-declined alert) and an email
//    she keeps as her copy of what was received and when;
//  - Or: an admin push + inbox item (type FORCA_CANCEL_REQUEST), only for
//    requests from the app (she entered the manual ones herself).
// Every send is best effort: a failed notification never undoes the request,
// which already counts as received.

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export function confirmationText(template: string, r: RequestReceipt): string {
  return fillTemplate(template, { childName: r.child.name, receivedAt: formatIsraelDateTime(r.receivedAt), requestNumber: r.requestNumber });
}

export function buildConfirmationEmail(text: string, r: RequestReceipt): { subject: string; html: string; senderName: string } {
  const t = getEmailBrandTokens('forca');
  const rows: [string, string][] = [
    ['מספר בקשה', r.requestNumber],
    ['התקבלה ב', formatIsraelDateTime(r.receivedAt)],
    ['ערוץ', CHANNEL_LABEL[r.source.channel]],
    ['מתאמנת', r.child.name],
    ...(r.subscription ? [['מנוי', `${r.subscription.productName}${r.subscription.groupName ? ` · ${r.subscription.groupName}` : ''}`] as [string, string]] : []),
    ['תוכן הבקשה', r.content.requestText],
    ...(r.choice ? [['בחירת ההורה', CHOICE_LABEL[r.choice]] as [string, string]] : []),
    ...(r.content.note ? [['הערה', r.content.note] as [string, string]] : []),
    // The file itself never leaves the system: only that one was received.
    ...(r.attachment ? [['אישור רפואי', `התקבל (${r.attachment.fileName})`] as [string, string]] : []),
  ];
  const html = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background-color:#f4f7f9;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;">
  <div style="max-width:600px;margin:20px auto;background-color:#ffffff;border-radius:8px;overflow:hidden;">
    <div style="background-color:${t.headerBg};padding:30px;text-align:center;">
      <img src="${t.logoUrl}" alt="${t.senderName}" height="${t.logoHeight}" style="height:${t.logoHeight}px;width:auto;max-width:220px;border:0;">
    </div>
    <div style="padding:32px 28px;color:#333333;line-height:1.6;text-align:right;">
      <h2 style="color:#2c3e50;margin-top:0;">${confirmationTitle(r)}</h2>
      <p style="white-space:pre-line;">${escapeHtml(text)}</p>
      <table style="width:100%;border-collapse:collapse;margin-top:20px;background-color:${t.accentBgLight};border-radius:8px;">
        ${rows.map(([k, v]) => `<tr><td style="padding:8px 12px;font-weight:bold;color:${t.accentColor};white-space:nowrap;vertical-align:top;">${escapeHtml(k)}</td><td style="padding:8px 12px;white-space:pre-line;">${escapeHtml(v)}</td></tr>`).join('')}
      </table>
      <p style="font-size:0.9em;color:#666;margin-top:20px;">יש לשמור הודעה זו: היא האישור על קבלת הבקשה.</p>
    </div>
    <div style="background-color:#f4f7f9;padding:20px;text-align:center;color:#888888;font-size:12px;">&copy; ${new Date().getFullYear()} ${t.senderName}</div>
  </div>
</body>
</html>`;
  return { subject: `${t.senderName}: ${confirmationTitle(r)} (${r.requestNumber})`, html, senderName: t.senderName };
}

/**
 * Push + in-app message + email to the parent. Returns which of them went out.
 * `choiceLine`: the fixed paragraph for the parent's choice (rules.choiceConfirmationLine).
 */
export async function sendParentConfirmation(
  parent: MemberProfileItem | null, template: string, r: RequestReceipt, choiceLine?: string,
): Promise<{ push: boolean; message: boolean; email: boolean }> {
  const sent = { push: false, message: false, email: false };
  const text = choiceLine ? `${confirmationText(template, r)}\n${choiceLine}` : confirmationText(template, r);
  const title = confirmationTitle(r);

  try {
    await ddb.send(new PutCommand({
      TableName: FORCA_TABLE_NAME,
      Item: {
        PK: `MEMBER#${r.parent.uid}`,
        SK: `MESSAGE#forcacancelreq_${r.requestId}`,
        type: 'admin_alert',
        title,
        body: text,
        createdAt: new Date().toISOString(),
        requiresAction: false,
        read: false,
        cancelRequestId: r.requestId,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
    sent.message = true;
  } catch (err) {
    console.error(`[forcaCancelRequest] ${r.requestId} in-app message failed:`, err);
  }

  try {
    const token = parent ? getExpoPushToken(parent) : null;
    if (token) {
      // Counts as sent only if Expo accepted it.
      const accepted = await sendExpoPushBatch([{ to: token, title, body: text, sound: 'default', data: { screen: 'ForcaTabs', initialTab: 'profile' } }], 'forcaCancelRequest');
      sent.push = accepted > 0;
    }
  } catch (err) {
    console.error(`[forcaCancelRequest] ${r.requestId} push failed:`, err);
  }

  if (r.parent.email) {
    try {
      await sendEmail({ to: r.parent.email, ...buildConfirmationEmail(text, r) }, 'forcaCancelRequest');
      sent.email = true;
    } catch (err) {
      console.error(`[forcaCancelRequest] ${r.requestId} email failed:`, err);
    }
  }
  return sent;
}

export async function notifyOrNewRequest(r: RequestReceipt): Promise<void> {
  try {
    await notifyAdmins({
      type: 'FORCA_CANCEL_REQUEST',
      priority: 'HIGH',
      brand: 'forca',
      pushTitle: r.type === 'medical_freeze' ? 'FORCA: הודעה על הקפאה רפואית' : 'FORCA: בקשה לביטול השתתפות',
      message: r.type === 'medical_freeze'
        ? `${r.parent.name} שלח/ה הודעה על הקפאה רפואית של ${r.child.name} עם אישור רפואי (${formatIsraelDateTime(r.receivedAt)}). מספר בקשה ${r.requestNumber}.`
        : `${r.parent.name} ביקש/ה לבטל את ההשתתפות של ${r.child.name} (${formatIsraelDateTime(r.receivedAt)}). מספר בקשה ${r.requestNumber}.`
          + (r.choice === 'early_legal' ? ` ${EARLY_LEGAL_FLAG}.` : r.choice ? ` בחירה: ${CHOICE_LABEL[r.choice]}.` : ''),
      extra: { requestId: r.requestId, memberId: r.child.uid },
      pushData: { type: 'FORCA_CANCEL_REQUEST', requestId: r.requestId },
    });
  } catch (err) {
    console.error(`[forcaCancelRequest] ${r.requestId} admin notification failed:`, err);
  }
}
