// Run (env: AWS_REGION=eu-central-1 FORCA_TABLE_NAME=forca-production-table):
//   npx --yes --package=tsx@4.19.2 -- tsx scripts/forcaActivityPeriods.ts report [YYYY-MM-DD]
//       read-only: every active FORCA subscription, its stored next charge date,
//       when it will really be charged under the saved periods, and who the
//       charge job would charge on the given day (default: next 1st of the month)
//   npx --yes --package=tsx@4.19.2 -- tsx scripts/forcaActivityPeriods.ts seed [--apply]
//       writes the initial periods (decided 2026-11-13) only if no periods record exists yet;
//       dry run unless --apply
import { israelDateStrOf } from '../src/lib/israelTime';
import { DEFAULT_SETTINGS, firstOfNextMonthDay, isChargeDay, type ActivityPeriod } from '../src/lib/forcaPeriods/rules';
import { displayName, effectiveNextChargeDateOf, listActiveAgreements, loadForcaProfiles, loadPeriodSettings, savePeriodSettings } from '../src/lib/forcaPeriods/store';

const SEED: ActivityPeriod[] = [
  { id: 'p-2026-10', name: 'אוקטובר–דצמבר 2026', start: '2026-10-01', end: '2026-12-31' },
  { id: 'p-2027-01', name: 'ינואר–מרץ 2027', start: '2027-01-01', end: '2027-03-31' },
  { id: 'p-2027-04', name: 'אפריל–יוני 2027', start: '2027-04-01', end: '2027-06-30' },
  { id: 'p-2027-09', name: 'ספטמבר / היכרות', start: '2027-09-01', end: '2027-09-30' },
];

async function report(dayArg?: string) {
  const today = israelDateStrOf(new Date());
  const day = dayArg ?? firstOfNextMonthDay(today);
  const settings = await loadPeriodSettings();
  const agreements = await listActiveAgreements();
  const profiles = await loadForcaProfiles(agreements.map((a) => a.userId));
  console.log(`periods saved: ${settings.exists ? settings.periods.length : 'none (record missing)'}; active FORCA subscriptions: ${agreements.length}`);
  const rows = agreements.map((a) => {
    const due = a.nextChargeDate ? israelDateStrOf(new Date(a.nextChargeDate)) : null;
    return {
      child: displayName(profiles.get(a.userId), a.userId),
      payer: a.payerName,
      product: a.productName,
      amount: a.amountPerCharge,
      hasCard: !!a.token,
      failures: a.consecutiveFailures,
      storedNextCharge: due,
      effective: settings.exists ? effectiveNextChargeDateOf(settings.periods, a.nextChargeDate) : '(no periods)',
      dueOnDay: !!due && due <= day,
    };
  }).sort((x, y) => String(x.storedNextCharge).localeCompare(String(y.storedNextCharge)) || x.child.localeCompare(y.child));
  console.table(rows);
  const periodsForDay = settings.exists ? settings.periods : SEED;
  const chargeDay = isChargeDay(periodsForDay, day);
  const charged = rows.filter((r) => r.dueOnDay && r.hasCard);
  console.log(`\n${day}: ${chargeDay ? 'inside a period' : 'NOT inside a period → nothing charged'}${settings.exists ? '' : ' (judged by the seed periods)'}`);
  if (chargeDay) {
    console.log(`would charge ${charged.length} subscription(s), total ₪${charged.reduce((s, r) => s + r.amount, 0)}:`);
    for (const r of charged) console.log(`  - ${r.child} (payer ${r.payer}) · ${r.product} · ₪${r.amount}`);
    const noCard = rows.filter((r) => r.dueOnDay && !r.hasCard);
    if (noCard.length) console.log(`due but no card on file (fails, admins alerted): ${noCard.map((r) => r.child).join(', ')}`);
  }
}

async function seed(apply: boolean) {
  const current = await loadPeriodSettings();
  if (current.exists) {
    console.log(`periods record already exists (version ${current.version}, ${current.periods.length} periods) — not touching it.`);
    console.table(current.periods);
    return;
  }
  console.log(`${apply ? 'writing' : 'would write'} ${SEED.length} periods, reminder ${DEFAULT_SETTINGS.reminderDaysBefore} days before:`);
  console.table(SEED);
  if (!apply) return;
  const saved = await savePeriodSettings({
    periods: SEED,
    reminderDaysBefore: DEFAULT_SETTINGS.reminderDaysBefore,
    reminderTitle: DEFAULT_SETTINGS.reminderTitle,
    reminderBody: DEFAULT_SETTINGS.reminderBody,
    updatedAt: new Date().toISOString(),
    updatedBy: 'seed-script',
  }, 0);
  console.log(`saved, version ${saved.version}`);
}

(async () => {
  const [cmd, arg] = process.argv.slice(2);
  if (!process.env.FORCA_TABLE_NAME) throw new Error('set FORCA_TABLE_NAME');
  if (cmd === 'report') await report(arg && /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : undefined);
  else if (cmd === 'seed') await seed(process.argv.includes('--apply'));
  else console.log('usage: report [YYYY-MM-DD] | seed [--apply]');
})().catch((err) => { console.error(err); process.exit(1); });
