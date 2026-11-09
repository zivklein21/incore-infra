# WIP: history paging, phase 2. Do not plan, apply or merge.

This branch (`feature/history-paging-phase2`) is unfinished and not approved for deploy.

What's here:
- FORCA attendance history reads registrations off GSI1 instead of a table Scan. Needs `scripts/backfillRegistrationIndex.ts` (dry run first).
- Training History reads 2-month windows day by day off GSI2 `CLASSDATE#<date>`.
- Admin and coach support inboxes read a GSI2 inbox partition per brand. Needs `scripts/backfillInquiryIndex.ts` (dry run first).

Before any of it ships:
1. Run both backfill scripts as dry runs and estimate the cost/size.
2. Decide on items 4 (all memberships), 11 (signed forms) and 12 (billing agreements), and on whether a new GSI is needed.
3. Move the admin badge's `?openCount=1` Scan onto the inbox index.
4. Review, then plan from this branch (it has the S3 backend) and get approval.

Delete this file in the commit that makes the branch ready to merge.
