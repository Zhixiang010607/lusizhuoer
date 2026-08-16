# Final Data Model

This document defines the final business model. SQL identifiers remain ASCII-only.

## 1. Account and identity

`staff_accounts` is the only login account table. It stores CloudBase UID, one unique phone number, password-auth identity, and account status.

Each account has exactly one active business identity through `account_identity_links`:

| Account role | Linked business entity | Global view scope |
| --- | --- | --- |
| `hq` | `hq_profiles` | All business data |
| `operation` | `operation_profiles` | Assigned stores only |
| `store` | `stores` | Its own store only |
| `teacher` | `teachers` | Its own records only |

`account_role_assignments` and `role_permissions` hold the permissions. A phone number occurs once in `staff_accounts`, so it can never receive two active identities.

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
| Operation person | `operation_profiles` | One login account; optional store scopes |
| Teacher | `teachers` | One login account; identity-card hash and encrypted value are HQ-only |
| Store | `stores` | Province, city, district, address; multiple `store_contacts`; one active store login binding |
| Product | `products` | Product status and product details |
| Customer | `customers` | Created store, face-library person ID and consent time; no customer phone is stored |

`operation_store_scopes` is the only way an operation account receives access to a store. No scope means no store data access.

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
| `REJECTED` | 拒绝/作废 | Failed, rejected, or later voided verification |

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

## 5. Detail pages and global views

Each `recharge_records.id` and `verification_records.id` is a standalone detail page source.

The database views provide global summaries without replacing detail records:

| View | Purpose |
| --- | --- |
| `v_account_access` | Resolve logged-in account, identity ID, role, permissions |
| `v_store_global_view` | One store global view |
| `v_teacher_global_view` | One teacher global view |
| `v_operation_global_view` | One operation global view within assigned stores |
| `v_hq_global_view` | Headquarters-wide global view |
| `v_product_store_summary` | Product statistics by store and period |
| `v_product_teacher_summary` | Product verification statistics by teacher and period |

## 6. Data access

| Role | Can read |
| --- | --- |
| Headquarters | All master data, all records, all global views |
| Operation | Only assigned-store records and summaries |
| Store | Its own store, customers, recharge records, verification records |
| Teacher | Only its own recharge and verification records; no other teacher or store global view |

The access restriction is implemented in PostgreSQL RLS and must also be checked by cloud functions. Frontend navigation alone is never treated as permission control.

## 7. Run order for the current database

The current CloudBase database already has the initial schema. Run these additive migrations in order:

```text
006_global_views_and_access_scopes.sql
007_account_identity_and_permission_model.sql
008_recharge_and_verification_workflow_status.sql
```

Do not run the old review-request tables for new business flow. They remain only for legacy compatibility and will not be shown by the application.
