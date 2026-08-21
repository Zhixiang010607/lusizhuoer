# Final Data Model

This document defines the final business model. SQL identifiers remain ASCII-only.

## 1. Account and identity

`staff_accounts` is the only login account table. It stores CloudBase UID, one unique phone number, password-auth identity, and account status.

Each current account has exactly one active business identity through
`account_identity_links`:

| Account role | Linked business entity | Global view scope |
| --- | --- | --- |
| `hq` | `hq_profiles` | All business data |
| `store` | `stores` | Its own store only |
| `teacher` | `teachers` | Its own records only |

`account_role_assignments` and `role_permissions` hold the permissions. A phone number occurs once in `staff_accounts`, so it can never receive two active identities.

Migration 047 retires the former `operation` identity. It preserves the old
account, identity-link, role-assignment, profile, scope and review foreign-key
rows as archive/audit data, but no active operation account, permission or
business identity remains.

Account and master-person status use only:

```text
ACTIVE
ARCHIVED
```

An archived account cannot sign in. Archiving does not delete historical records.

## 2. Master data

| Entity | Main table | Required relationships |
| --- | --- | --- |
| Headquarters person | `hq_profiles` | One login account |
| Teacher | `teachers` | One login account; identity-card hash and encrypted value are HQ-only |
| Store | `stores` | Province, city, district, address; multiple `store_contacts`; one active store login binding |
| Product | `products` | Product status and product details |
| Customer | `customers` | Created store, face-library person ID and consent time; no customer phone is stored |

Teacher face enrollment remains independent from account activation after
migration 048: an existing active teacher without a face is not automatically
archived, and an authorized face replacement never changes account status.
Current new-teacher creation nevertheless requires one consented face and does
not report success until that face, the private original, database references,
teacher master, staff account, and Auth account are all read back. Customer 1:1
verification remains required for ordinary verification orders.

Teacher experience allowances use `teacher_product_experience_quotas` plus
immutable configuration, recharge, reset and usage ledgers. A live quota is
`ACTIVE`; deleting a configuration archives it rather than deleting its audit
lineage. Reconfiguration immediately replaces the current available count with
the selected monthly allowance. All-time per-product experience totals are
derived from the immutable usage ledger, not the mutable current-month count.

`operation_profiles` and `operation_store_scopes` are retained only as archived
audit history. Migration 047 archives any remaining operation identity, scope
and permission rows and blocks their reactivation or reuse. They grant no
login, review, customer, photo, query, management or business-operation scope.

## 3. Recharge record

One recharge creates one row in `recharge_records`. No extra recharge or void document is created.

Every recharge row must bind all four business entities:

```text
store_id
teacher_id
customer_id
product_id
```

Recharge status has exactly three values:

| Value | UI label | Meaning |
| --- | --- | --- |
| `PENDING` | 待审核 | Newly submitted recharge, not usable yet |
| `APPROVED` | 通过 | Approved recharge, usable balance |
| `REJECTED` | 作废 | Rejected during review or voided later |

Allowed changes are:

```text
PENDING  -> APPROVED
PENDING  -> REJECTED
APPROVED -> REJECTED
```

Each change is recorded in `record_status_history` on the same recharge ID.

## 4. Verification record

One verification creates one row in `verification_records`. No second verification-review document is created.

Every verification row binds:

```text
store_id
teacher_id
customer_id
product_id
```

Verification status also has exactly three values:

| Value | UI label | Meaning |
| --- | --- | --- |
| `PENDING` | 待处理 | Record is awaiting a business decision or face result |
| `APPROVED` | 通过 | Valid consumption; normal successful face verification writes this directly |
| `REJECTED` | 已驳回 | Failed or rejected verification |
| `VOIDED` | 历史已作废 | Legacy audit state only; new verification voids are disabled by migration 036 |

Verification also has one independent tag:

| Value | UI label |
| --- | --- |
| `NORMAL` | 正常 |
| `SUPPLEMENT` | 补录 |
| `EXPERIENCE` | 体验 |

And one independent technical face result:

| Value | Meaning |
| --- | --- |
| `NOT_STARTED` | No face request yet |
| `PASSED` | Face recognition passed |
| `FAILED` | Face recognition failed |
| `ERROR` | Face service error |

The face result is not a second business document. A normal scan becomes:

```text
verification_tag = NORMAL
face_status = PASSED
record_status = APPROVED
```

Every verification created after migrations 037 and 038 also has private photo evidence:

- `verification_photo_drafts` holds a short-lived, unconsumed face photo after successful 1:1 verification and before the order transaction.
- `verification_photos` has five fixed slots per order. Slot 0 snapshots the customer's retained enrollment-photo reference, slot 1 is the immutable face-verification original and thumbnail, and slots 2--4 are optional supplemental originals and thumbnails.
- The face evidence token is bound to the exact store, customer, submitting staff account and face API request, then consumed atomically by `create_verification_with_face_photo` when the order is inserted.
- Only `verification_records.submitted_by_account_id` may insert or replace slots 2--4, and only while the database server time is earlier than `submitted_at + interval '24 hours'`. Slots 0 and 1 are immutable. The trigger repeats these rules even if a stale or modified browser bypasses the UI.
- PostgreSQL stores private `pg://` object references, byte counts, dimensions and SHA-256 metadata. It never stores public or signed URLs. Direct `anon` and `authenticated` table access is revoked and RLS is enabled without client policies.
- `verification_photo_events` is append-only application audit data for retained-profile binding, face binding, supplemental upload/replacement and every original-photo view. Thumbnail display does not create five extra writes on each detail-page load.

## 5. Detail pages and global views

Each `recharge_records.id` and `verification_records.id` is a standalone detail page source.

The database views provide global summaries without replacing detail records:

| View | Purpose |
| --- | --- |
| `v_account_access` | Resolve logged-in account, identity ID, role, permissions |
| `v_store_global_view` | One store global view |
| `v_teacher_global_view` | One teacher global view |
| `v_hq_global_view` | Headquarters-wide global view |
| `v_product_store_summary` | Product statistics by store and period |
| `v_product_teacher_summary` | Product verification statistics by teacher and period |

## 6. Data access

| Role | Can read |
| --- | --- |
| Headquarters | All master data, all records, all global views |
| Store | Its own store, customers, recharge records, verification records |
| Teacher | Only its own recharge and verification records; no other teacher or store global view |

The access restriction is implemented in PostgreSQL RLS and must also be checked
by cloud functions. Review actions are headquarters-only. `staffAccount`
rejects a retired operation identity even if an old CloudBase credential is
present, and `faceRecognition` has no operation-only customer-context action.
Migration 047 also prevents a non-HQ reviewer from being written to either
order table. Frontend navigation alone is never treated as permission control.
Verification orders cannot start or change a void lifecycle after migration 036;
corrections use a separate recharge order.

## 7. Run order for the current deployment

For a database already upgraded through migration 029, execute the current
additive files separately through migration 046, complete the controlled 047
retirement cutover, then execute the remaining migrations through 053:

```text
030_store_customer_query_indexes.sql
031_store_dashboard_indexes.sql
032_restrict_order_void_eligibility.sql
033_hq_query_indexes.sql
034_operation_review_only_access.sql
035_hq_dashboard_approved_covering_indexes.sql
036_disable_verification_void_workflow.sql
037_verification_photo_evidence.sql
038_verification_profile_photo_snapshot.sql
039_direct_verification_photo_upload.sql
040_fix_verification_photo_commit_ambiguity.sql
041_experience_verification_device_signal.sql
042_customer_messages.sql
043_disable_recharge_void_workflow.sql
044_refund_application_workflow.sql
045_product_receipt_templates.sql
046_teacher_face_and_experience_quotas.sql
047_retire_operation_accounts.sql
048_optional_teacher_face_and_experience_quota_lifecycle.sql
049_teacher_experience_face_subject_and_quota_fixes.sql
050_teacher_profile_repair_and_quota_ambiguity.sql
051_teacher_face_operation_lease.sql                  (historical; retired by 053)
052_teacher_auth_create_receipt.sql                   (historical; retired by 053)
053_retire_legacy_teacher_face_saga.sql
```

After 046 has committed, deploy `faceRecognition v69` and `staffAccount v50`
and verify both health responses. From an authenticated headquarters session on
a restricted maintenance page that loads the current `cloudbase-phone-auth.js`,
run `CloudBasePhoneAuth.retireOperationAccounts()` and wait for a successful
result that blocks the old CloudBase credentials. Only then execute
`047_retire_operation_accounts.sql` (in the CloudBase SQL editor,
`047-01-retire-operation-accounts.sql` followed by
`047-02-hq-reviewer-guard.sql`). Then execute
`048_optional_teacher_face_and_experience_quota_lifecycle.sql` (or the seven
ordered `048-01` through `048-07` CloudBase console parts). Next execute the
ordered `049-01` through `049-13` parts and `049-readonly-verify.sql`, then 050.
For a database that already ran historical 051/052, deploy `staffAccount v67`,
`faceRecognition v80`, and `teacherCreate v6` before executing 053. Run the 053
read-only verification and require all seven rows to be `RETIRED`, remove the
old teacher-face reconciliation Timer, then deploy `verificationPhoto v5` and
the current static frontend. A fresh database still follows numeric order; 053
immediately removes the historical 051/052 orchestration objects.

Migration 032 deliberately stops and rolls back when migration 026 is missing.
In that case, do not deploy the new cloud functions yet; first complete the
missing earlier migrations in numeric order. Migration 034 retains operation
scope rows as archived audit history. Migration 035 adds only the two covering
indexes used by the headquarters dashboard's date-bounded approved-order
aggregation. Migration 036 closes any legacy pending verification void as
rejected without changing the original verification or balance, retires the old
direct SQL function, and blocks every future verification void transition.
Migration 037 adds private verification photo metadata, the atomic
order-plus-face-photo insertion function, and the submitter/24-hour database
guard. Migration 038 adds the immutable customer enrollment-photo snapshot and
shifts the face/extras into slots 1 and 2--4. Migration 047 preserves history
while permanently retiring the former operation role and making reviews
headquarters-only. Migration 048 leaves historical teacher face columns nullable,
archives rather than deletes removed experience configurations, makes a new
configuration immediately replace the current balance, and resets only active
teacher/product/configuration combinations at the Shanghai month boundary.
Migration 049 is retained as historical deployment order. Migration 054
supersedes its teacher-face EXPERIENCE path: only the logged-in teacher can
create a new EXPERIENCE record, the teacher quota is consumed atomically, and
both immutable receipt photos belong to the selected customer. Historical rows
retain their original face-subject metadata.
Migration 055 replaces the two remaining legacy order-boundary functions so an
active teacher and active teacher account can receive recharge, refund, normal
verification, and experience orders without teacher face enrollment. Customer
retained-photo and live 1:1 customer-face requirements remain unchanged.
Migration 050 repairs legacy teacher master rows and quota write ambiguity.
Migrations 051/052 describe a retired orchestration design and are retained
only as immutable migration history. Migration 053 deletes only that design's
`teacher_face_operations` table and six private helpers; it does not delete
teachers, staff accounts, face references, quota ledgers, work orders, or
business history. Current teacher creation uses the independent, single-call
`teacherCreate v6` service and requires only name, unique phone, and password.
It creates no teacher face person or photo. Success requires the Auth account,
`staff_accounts` row, and `teachers` row to be read back as ACTIVE. Teacher
activation and login are face-independent.
Neither photo migration creates the CloudBase Storage
buckets, which must be created separately as private infrastructure.
