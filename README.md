# Mini Tallo

Mini Tallo lets an AI assistant (Claude Desktop, or any MCP client) read the TallyPrime books open on your computer and prepare voucher import files. It also has a web dashboard for you to view the reports and, if you switch editing on, to add, change and delete masters and vouchers yourself.

The assistant cannot change your books unless you turn posting on and approve each voucher. The dashboard cannot change them unless you tick **Allow editing**.

> **Status: 0.1.0, not yet run against a real TallyPrime.** Every tool passes its tests against a stand-in gateway in `test/mock-tally.js`, which answers the way TallyPrime is documented to. Before you rely on any figure, run each tool once against a real company and compare with TallyPrime's own report. See [What has been checked](#what-has-been-checked).

## Install

You need Node.js 20 or later and TallyPrime running on the same computer with a company loaded.

1. In TallyPrime, turn the gateway on: `F1 (Help) > Settings > Connectivity > Client/Server configuration`, set **TallyPrime acts as** to `Both` and note the port (9000 by default).
2. In this folder, run `npm install`.
3. Add Mini Tallo to your MCP client. For Claude Desktop, either:
   - pack and install the extension: `npx @anthropic-ai/mcpb pack`, then open the `.mcpb` file it writes, or
   - add it to `claude_desktop_config.json` by hand:

     ```json
     {
       "mcpServers": {
         "mini-tallo": {
           "command": "node",
           "args": ["C:\\mini tally\\src\\server.js"],
           "env": { "MINI_TALLO_TERMS_ACCEPTED": "true" }
         }
       }
     }
     ```

4. Read [TERMS.md](TERMS.md) and accept it in the settings. Every tool refuses with `terms_not_accepted` until you do.

### Settings

| Setting (environment variable) | Default | What it does |
| --- | --- | --- |
| Accept terms (`MINI_TALLO_TERMS_ACCEPTED`) | off | Must be `true` before any tool answers. |
| Posting (`MINI_TALLO_POSTING`) | off | `true` adds `post_import` and `acknowledge_post_review`. |
| Privacy (`MINI_TALLO_REDACT`) | `none` | `names` or `narrations`. One value, not both. |
| Port (`MINI_TALLO_PORT`) | `9000` | TallyPrime's gateway port on this computer. |
| Data folder (`MINI_TALLO_DATA_DIR`) | `%LOCALAPPDATA%\MiniTallo` | Where receipts, import files and proposals are kept. |

## Dashboard

Mini Tallo also has a web dashboard that shows the reports in your browser, without an assistant.

- `npm run dashboard` reads the TallyPrime on this computer and opens `http://127.0.0.1:8787/`.
- `npm run dashboard:demo` shows a made-up company, "Demo Traders", so you can look around without TallyPrime.

Its layout follows TallyPrime's screens, under Mini Tallo's own name:

- **Home (Dashboard):** eight tiles for the chosen period: Sales Trend, Purchase Trend, Cash In/Out Flow, Trading Details, Nett Profit Trend, Receivables/Payables, Assets/Liabilities and Top Groups/Ledgers. Clicking a tile opens the report behind it. For a book with stock items, the profit figures are left off the tiles, because ledger balances leave out closing stock.
- **Gateway list on the left:** Masters, Day Book, Balance Sheet, Profit & Loss A/c, Trial Balance, Cash Flow, Sales Register, Purchase Register, Bills Outstanding, Stock Summary and Status.
- **Go To:** the `G: Go To` button or `Alt+G` opens a list of reports. Type to filter, use the arrow keys, and press Enter.
- **Key bar on the right:** `F2` Period, `F3` Select Company, `F5` Refresh, plus Create Voucher and Create Master. `F5` refreshes the report, not the browser page; use `Ctrl+R` for that.

You pick the company and dates at the top. You accept the Terms of Use once on the page. The month-wise trends read every voucher in the period, so a long period on a large book will be slow.

It listens on this computer only and answers only its own page. Nothing it shows goes to an AI provider, so the privacy setting does not apply to it. Each report it loads still leaves a receipt. Building import files, reading bank statements and assistant posting stay with the assistant tools.

### Editing from the dashboard

The dashboard can also create, change and delete things in your TallyPrime books. This is off every time the dashboard starts. You turn it on with the **Allow editing** box at the top, after a warning, and a red banner stays up while it is on.

| Where | What you can do |
| --- | --- |
| Masters page | New, Edit (including rename) and Delete for ledgers, account groups, stock groups, stock items, units, godowns, cost categories and cost centres. |
| Vouchers page | New and Edit for Journal, Payment, Receipt and Contra vouchers. Delete for any voucher. |

The report pages (Trial Balance, Profit & Loss, Balance Sheet, Cash Flow, the registers, Outstandings, Stock) are calculated from the masters and vouchers, so there is nothing on them to edit.

Before you use it:

- **A change goes into TallyPrime straight away and Mini Tallo cannot undo it.** Take a backup in TallyPrime first, and try it on a test company before a real one.
- **Every save and delete is read back.** Mini Tallo says "done" only when the book shows the change. If TallyPrime refuses, for example deleting a ledger that has vouchers, you see TallyPrime's reason and nothing is reported as done.
- **Editing a voucher replaces all of its lines.** That is why Sales, Purchase and other vouchers that can carry stock, bills or GST details can be deleted here but not edited.
- **Not carried by the forms:** GST and party details on ledgers, bill-wise allocations, cost centre allocations on voucher lines, stock item opening balances and compound units. Editing a master that has such details may clear some of them; this has not been checked on a real TallyPrime.
- **The assistant cannot do any of this.** The editing tools are not offered to an MCP client at all. They exist only behind the dashboard page.

## Its tools

There are 24 tools, in name order. None of them changes your TallyPrime books, and every call adds a receipt line, with no figures, to a log on this computer.

| Tool | What it gives you | What it writes besides that receipt |
| --- | --- | --- |
| `balance_sheet` | The Balance Sheet as of the end of a date range, by primary group, built from the trial balance. A book with stock items is refused. | Nothing |
| `build_import_xml` | Checks a Journal, Payment, Receipt or Contra batch against the live book and writes an import file. | An import file and a ledger record on this computer |
| `cash_flow` | Month-wise movement of the cash and bank ledgers for whole months, returned only after the months add up to the whole-period movement. Not a cash flow statement under AS 3. | Nothing |
| `egress_log` | The receipts Mini Tallo keeps of its own tool calls, with no figures. | Nothing |
| `ledger_masters` | Ledgers with their opening balances; optionally GSTIN, PAN and other party details. | Nothing |
| `ledger_movement` | A ledger's opening, debits, credits and closing for a period. | Nothing |
| `list_companies` | The companies loaded in TallyPrime. Start here. | Nothing |
| `local_data_report` | What Mini Tallo keeps on this computer. | Nothing |
| `masters` | Voucher types, godowns, units, stock groups, cost centres, cost categories or account groups. | Nothing |
| `outstandings` | Receivables and payables with ageing by bill date, the top parties and the open bills. | Nothing |
| `parse_bank_statement` | Reads an SBI, HDFC or Union Bank of India statement PDF and proposes Payment, Receipt and Contra vouchers. A protected PDF's password is asked for in a Mini Tallo window, not through the assistant. | A private proposals file on this computer |
| `profit_and_loss` | The Profit and Loss for a date range, by primary group. A book with stock items is refused. | Nothing |
| `purchase_register` | Purchase and Debit Note vouchers that touch a ledger under Duties & Taxes, as the books record them. Not a GST return. | Nothing |
| `read_evidence` | Mini Tallo's own recent reads from TallyPrime, as fingerprints, with no figures. | Nothing |
| `sales_register` | Sales and Credit Note vouchers that touch a ledger under Duties & Taxes, as the books record them. Not a GST return. | Nothing |
| `statement_tie_out` | Whether the bank ledger stands where a parsed statement says it stood at the start and end of the statement's dates, or of the whole calendar months inside it: three gaps and the dates. The balances themselves are not returned. | Nothing |
| `stock_summary` | The closing stock value of each item as of a 31 March, values only. More than 500 stock items is refused, and so is any other date. | Nothing |
| `tally_status` | Whether TallyPrime's gateway answers, and which companies are loaded. | Nothing |
| `trial_balance` | The ledger-wise Trial Balance for a date range. | Nothing |
| `validate_masters` | Checks ledger names against the live book before you build an import file. | Nothing |
| `verify_import` | Reads back a batch you imported by hand in TallyPrime. | A proof file and a status record on this computer |
| `voucher_presence` | Which proposed vouchers are already in the book. | Nothing |
| `voucher_schema` | The voucher-file format, without asking TallyPrime. | Nothing |
| `vouchers` | The vouchers in a period, with search by voucher number, reference, narration, amount or ledger, and summaries by ledger, month, voucher type, group or primary group. | Nothing |

With posting turned on, two more appear: `post_import` posts one saved voucher after you approve it in a Mini Tallo window, and `acknowledge_post_review` asks you, in its own window, to record that you reviewed a posted voucher that was flagged (for example because a ledger now points to a different master).

Amounts come back in rupees, with debit balances positive and credit balances negative.

## How it handles your books

- **Local connection only.** It talks to TallyPrime's own XML gateway on a loopback address and refuses any other host. It cannot tell whether that local port is forwarded to another machine; do not forward one across the internet. Mini Tallo itself sends nothing to any server.
- **Your AI provider sees what the assistant reads**, just as it sees the rest of the conversation: company, party and ledger names, amounts, dates, narrations, references, GSTINs and, when it reads ledger details, PAN, bank account numbers, IFSC, MSME or Udyam numbers, email, phone and address. When it builds a voucher file it also sees that file's path, which can include your computer user name.
- **The privacy setting takes one value, not both.** `names` shortens party and ledger names and bank account numbers to their first two and last two characters (four or fewer become "…"). `narrations` drops narrations. Neither hides amounts, company names, group names, PAN, GSTIN, IFSC, contact details, references, or the last four digits of a statement's account number, and a shortened name can still be identified from the GSTIN or PAN beside it. With `names` on, the assistant cannot name a ledger back to a tool, so `ledger_movement` and building vouchers will not work.
- **Receipts.** Each tool call leaves a line in `egress.jsonl`: the time, the tool, the company's Tally identifier, the outcome, and a fingerprint of what was asked and of what came back. It is written whether the call succeeds or is refused.
- **Statement balances stay on this computer.** `parse_bank_statement` keeps them in a private proposals file; `statement_tie_out` returns only the gaps.

## Before you turn on posting

Posting is off by default. With it on, each voucher waits for your approval in a separate Mini Tallo window in your browser. No tool lets the assistant approve it: the window's address carries a secret given only to your browser, and an approval counts only when the window returns a fresh one-time token. Just before sending, Mini Tallo checks again that the company is the one the batch was built for and that its ledgers exist. After posting, the voucher is read back so you can see what landed.

Known limits:

- Mini Tallo cannot undo a posted voucher. You correct it in TallyPrime.
- A company renamed to, or loaded under, the target company's name in the moment between the last check and the post could still receive the voucher, if it has the voucher's ledgers.
- A ledger renamed and replaced in that same moment could receive the entry. Mini Tallo flags a post for review when a ledger name points to a different master than when the file was built, but not every such change is noticed.
- The approval window covers only Mini Tallo. Another Tally connector in the same assistant that can change entries can do so without it.
- An assistant that can also run programs on your computer (a shell tool, for example) is outside what the approval window protects against.

## What has been checked

`npm test` runs 37 tests. They cover every tool against a synthetic book of 6 vouchers served by `test/mock-tally.js`, the approval window over real HTTP, a hand-made statement PDF and a password-protected one, the server over stdio, and the dashboard's server including every create, change and delete. The dashboard page was also driven once in a headless browser on the demo data: every page loaded, the home tiles and Go To worked, and a ledger and a voucher were each created, changed and deleted through the forms.

Not checked:

- **Any real TallyPrime.** The requests are inline TDL collections. Field names such as `$TBalOpening`, `$TBalDebits`, `$TBalCredits`, the `Bills` collection and the party-detail fields are written from knowledge of TallyPrime's XML interface, not from a live response. Where a figure can be cross-checked the tools do it and say so (`trial_balance` reports whether closings sum to zero and whether opening plus movement equals closing; `balance_sheet` and `cash_flow` refuse when their totals do not agree).
- **Writing to a real TallyPrime.** The create, alter and delete requests follow TallyPrime's import format as I know it. How TallyPrime locates a voucher to alter or delete (by its identifier and master id) is the least certain part. The read-back after each write is there to catch a write TallyPrime ignored.
- **Real bank statements.** The parser places each row by the statement's running balance, which does not depend on a bank's layout, but it has only read synthetic HDFC-style pages. Scanned statements cannot be read.
- **Item invoices.** Vouchers entered in item-invoice mode keep their sales or purchase lines under stock lines; the reader looks for them there, untested.
- **Large books**, multi-currency, bill-wise allocations, cost centres and GST details in import files (the last four are not supported).
- **The approval window opening in your browser** on a real desktop. The tests drive it over HTTP without a browser.

## Licence

Apache-2.0. See [LICENSE](LICENSE). The Terms of Use in [TERMS.md](TERMS.md) are a draft and have not had legal review.
