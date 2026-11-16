// Pulls provider, kind, amount, due date and account digits out of a utility email.
// Kept free of Deno APIs so it can be unit-tested with Node.

export type Parsed = {
  provider: 'pseg' | 'nationalgrid' | 'liberty' | null;
  kind: 'bill' | 'payment' | 'other';
  amount: number | null;
  dueDate: string | null; // YYYY-MM-DD
  digits: string[];       // long digit runs found (possible account numbers)
};

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

export function detectProvider(from: string, subject: string, text: string): Parsed['provider'] {
  const s = (from + ' ' + subject).toLowerCase();
  const t = text.toLowerCase();
  if (/pseg|psegliny/.test(s)) return 'pseg';
  if (/national\s*grid|nationalgrid/.test(s)) return 'nationalgrid';
  if (/liberty/.test(s)) return 'liberty';
  if (/psegliny|pseg long island/.test(t)) return 'pseg';
  if (/nationalgridus|national grid/.test(t)) return 'nationalgrid';
  if (/libertyenergyandwater|libertyutilities|liberty utilities|liberty water/.test(t)) return 'liberty';
  return null;
}

function toIso(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2100)) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Parse the first date at the start of `s`
function parseDateAt(s: string, fallbackYear: number): string | null {
  let m = s.match(/^\s*(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) return toIso(+m[3], +m[1], +m[2]);
  m = s.match(/^\s*(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?/i);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase().slice(0, 4)] ?? MONTHS[m[1].toLowerCase().slice(0, 3)];
    if (mo) return toIso(m[3] ? +m[3] : fallbackYear, mo, +m[2]);
  }
  m = s.match(/^\s*(\d{1,2})[\/\-](\d{1,2})(?![\/\-\d])/);
  if (m) return toIso(fallbackYear, +m[1], +m[2]);
  return null;
}

const money = (s: string) => {
  const n = parseFloat(s.replace(/,/g, ''));
  return isFinite(n) ? Math.round(n * 100) / 100 : null;
};

export function parseEmail(from: string, subject: string, text: string, received: Date): Parsed {
  const provider = detectProvider(from, subject, text);
  const flat = (subject + '\n' + text).replace(/ /g, ' ').replace(/[ \t]+/g, ' ');
  const low = flat.toLowerCase();

  let kind: Parsed['kind'] = 'other';
  if (/(thank you for your payment|payment (has been )?(received|processed|confirmation|confirmed|was successful|successful)|we('ve| have) received your payment|your payment of|payment posted|autopay (payment )?(processed|completed))/.test(low)) kind = 'payment';
  else if (/(bill is (ready|available)|new bill|bill (has been )?posted|statement is (ready|available)|amount due|total due|balance due|payment due|due date|your (e-?)?bill|billing statement)/.test(low)) kind = 'bill';

  // Amount: prefer the number right after an "amount due"-style label
  const amountLabels = kind === 'payment'
    ? ['payment amount', 'amount paid', 'your payment of', 'payment of', 'amount']
    : ['total amount due', 'amount due', 'total due', 'balance due', 'amount to pay', 'new balance', 'current charges', 'total current charges', 'bill amount', 'amount'];
  let amount: number | null = null;
  for (const label of amountLabels) {
    const re = new RegExp(label.replace(/ /g, '\\s*') + '[^$\\d]{0,40}\\$\\s?([\\d,]+\\.\\d{2})', 'i');
    const m = flat.match(re);
    if (m) { amount = money(m[1]); break; }
  }
  if (amount == null) {
    const all = Array.from(flat.matchAll(/\$\s?([\d,]+\.\d{2})/g)).map((m) => money(m[1])).filter((n): n is number => n != null && n > 0);
    const uniq = Array.from(new Set(all));
    if (uniq.length === 1) amount = uniq[0]; // only trust a lone dollar figure
  }

  // Due date: the date right after a "due" label
  let dueDate: string | null = null;
  if (kind !== 'payment') {
    const year = received.getFullYear();
    const re = /(payment due date|due date|due by|due on|is due|payment due|pay by|amount due by|due)(?:\s+(?:by|on|date))?\s*[:\-–]?\s*/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(flat))) {
      const d = parseDateAt(flat.slice(m.index + m[0].length, m.index + m[0].length + 40), year);
      if (d) {
        // a date earlier than the email is probably a different year (Dec email, Jan due)
        const dd = new Date(d + 'T12:00:00Z');
        if (dd.getTime() < received.getTime() - 40 * 86400000) dd.setUTCFullYear(dd.getUTCFullYear() + 1);
        dueDate = dd.toISOString().slice(0, 10);
        break;
      }
    }
  }

  const digits = Array.from(new Set(Array.from(flat.matchAll(/(?:\d[\s-]?){4,14}\d/g)).map((m) => m[0].replace(/\D/g, '')).filter((d) => d.length >= 4)));
  return { provider, kind, amount, dueDate, digits };
}

// Which of the provider's accounts does this email mention? Matches full numbers or a
// trailing fragment of 4+ digits (emails often show "ending in 6003" or "****6003").
export function matchAccount(textDigits: string[], rawText: string, accounts: { id: string; account_number: string | null }[]): string | null {
  const withNums = accounts.filter((a) => a.account_number && a.account_number.replace(/\D/g, '').length >= 4);
  const hits = new Set<string>();
  const flat = rawText.replace(/\D+/g, ' ');
  for (const a of withNums) {
    const num = a.account_number!.replace(/\D/g, '');
    if (textDigits.some((d) => d === num || (d.length >= 8 && num.endsWith(d)) || (d.length >= 8 && d.endsWith(num)))) { hits.add(a.id); continue; }
    if (flat.replace(/ /g, '').includes(num)) { hits.add(a.id); continue; }
    const tail = num.slice(-4);
    if (new RegExp('(ending|ends|last 4|account|acct|#|\\*{2,}|x{2,})[^\\d]{0,20}' + tail + '(?!\\d)', 'i').test(rawText)) hits.add(a.id);
  }
  if (hits.size === 1) return [...hits][0];
  if (hits.size === 0 && accounts.length === 1) return accounts[0].id;
  return null;
}
