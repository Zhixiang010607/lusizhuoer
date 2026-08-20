# Database rebuild preview

This document is a review-only preview for `schema.rebuild.sql`. The rebuild is
a base schema: a current deployment must still run the ordered migrations
through 048. Migration 047 retires the former operation role after its legacy
audit tables are available; migration 048 makes teacher face enrollment
optional and adds the teacher experience quota lifecycle.

It shows what every table stores, where the data comes from, and representative
rows. It intentionally contains no customer phone number, product price, or
recharge amount.

## Relationship overview

```text
staff_accounts
  |- credential_events
  |- teachers
  |- stores
  |- operation_store_scopes -> stores (legacy archived audit only)
  |- recharge_records
  |- verification_records
  `- record_status_history

stores -> customers
stores -> store_contacts
customers + products -> customer_product_balances
customers + stores + teachers + products -> recharge_records
customers + stores + teachers + products -> verification_records
```

## 1. `staff_accounts` - login accounts for HQ, store, and teacher

This is the only table containing login phone numbers. One phone can occur only
once, so one phone cannot receive two business identities. A user with
`ARCHIVED` status cannot sign in. `auth_uid` is required and is the universal
login identity used by HQ, store, and teacher accounts. Business codes remain
display codes and are not authentication identities. An old `operation` row
from a historical incremental database is preserved only as `ARCHIVED` audit
data by migration 047; it is not a current login role.

| Field | Meaning | Example |
|---|---|---|
| `id` | Internal account ID | `1` |
| `staff_code` | Automatically generated account code | `HQ001` |
| `auth_uid` | Required, globally unique CloudBase authentication identity | `2085744699220090881` |
| `phone` | Login phone only, unique | `139****2329` |
| `staff_name` | Account holder name | `乐玉米` |
| `role_code` | `hq`, `store`, or `teacher` for current accounts | `hq` |
| `account_status` | `ACTIVE` or `ARCHIVED` | `ACTIVE` |
| `password_initialized_at` | Initial temporary-password creation time | `2026-08-16 09:00` |
| `password_changed_at` | Last reset or self-change time | `2026-08-16 09:30` |
| `password_change_required` | Whether the user must replace a temporary password | `true` |
| `created_at` | Account creation time | `2026-08-16 09:00` |
| `updated_at` | Last account change time | `2026-08-16 09:00` |

| id | staff_code | staff_name | role_code | account_status |
|---:|---|---|---|---|
| 1 | HQ001 | 乐玉米 | hq | ACTIVE |
| 2 | TCH001 | 李老师 | teacher | ACTIVE |
| 3 | STA001 | 上海静安旗舰店账号 | store | ACTIVE |

If a historical database contains `OP001` or another operation account,
migration 047 retains its ID and audit references while setting the account and
related identity/permission rows to `ARCHIVED`; no new operation account can be
created or reactivated.

## 1a. `credential_events` - HQ-only password administration audit

This table records only who created, reset, or changed a credential and when.
It never contains an actual password or password hash. Only HQ can read it
through RLS.

| Field | Meaning | Example |
|---|---|---|
| `target_staff_account_id` | Account whose credential changed | `3` |
| `actor_staff_account_id` | HQ actor; null only for a system event | `1` |
| `event_type` | `ACCOUNT_CREATED`, `HQ_PASSWORD_RESET`, or `SELF_PASSWORD_CHANGED` | `HQ_PASSWORD_RESET` |
| `occurred_at` | Event time | `2026-08-16 09:30` |

## 2. `stores` - store master data

The store table stores the address, region, status, and its one linked store
account. It does not duplicate customer or product data.

| Field | Meaning | Example |
|---|---|---|
| `id` | Internal store ID | `1` |
| `store_code` | Auto-generated store code | `STR001` |
| `store_name` | Store name | `上海静安旗舰店` |
| `province` | Province or municipality | `上海市` |
| `city` | City | `上海市` |
| `district` | District | `静安区` |
| `address_detail` | Detailed address | `南京西路 100 号` |
| `store_account_id` | Linked store account | `4` |
| `store_status` | `ACTIVE` or `ARCHIVED` | `ACTIVE` |
| `created_at` / `updated_at` | System timestamps | `2026-08-16 09:10` |

| id | store_code | store_name | province / city / district | store_status |
|---:|---|---|---|---|
| 1 | STR001 | 上海静安旗舰店 | 上海市 / 上海市 / 静安区 | ACTIVE |

## 3. `store_contacts` - one or more store contacts

This supports the store creation rule that a store can have multiple contacts.
These are store contacts, not customer phone numbers.

| Field | Meaning | Example |
|---|---|---|
| `id` | Internal contact ID | `1` |
| `store_id` | Related store | `1` |
| `contact_name` | Contact name | `张店长` |
| `contact_phone` | Store contact phone | `181****2788` |
| `contact_status` | `ACTIVE` or `ARCHIVED` | `ACTIVE` |
| `is_primary` | Whether this is the primary contact | `true` |
| `created_at` / `updated_at` | System timestamps | `2026-08-16 09:10` |

| id | store_id | contact_name | is_primary | contact_status |
|---:|---:|---|---|---|
| 1 | 1 | 张店长 | true | ACTIVE |
| 2 | 1 | 陈前台 | false | ACTIVE |

## 4. `teachers` - teacher master data

Teachers do not have identity-card fields. Each teacher is automatically bound
to one teacher login account.

| Field | Meaning | Example |
|---|---|---|
| `id` | Internal teacher ID | `1` |
| `teacher_code` | Auto-generated teacher code | `TCH001` |
| `teacher_name` | Teacher name | `李老师` |
| `staff_account_id` | Related account | `3` |
| `teacher_status` | `ACTIVE` or `ARCHIVED` | `ACTIVE` |
| `created_at` / `updated_at` | System timestamps | `2026-08-16 09:20` |

| id | teacher_code | teacher_name | staff_account_id | teacher_status |
|---:|---|---|---:|---|
| 1 | TCH001 | 李老师 | 3 | ACTIVE |

## 5. `products` - product master data

Products have only code, name, category, description, and status. There is no
price field anywhere in this table.

| Field | Meaning | Example |
|---|---|---|
| `id` | Internal product ID | `1` |
| `product_code` | Auto-generated product code | `PRD001` |
| `product_name` | Product name | `面部护理` |
| `product_type` | Product category | `护理项目` |
| `description` | Optional description | `基础面部护理项目` |
| `product_status` | `ACTIVE` or `ARCHIVED` | `ACTIVE` |
| `created_at` / `updated_at` | System timestamps | `2026-08-16 09:25` |

| id | product_code | product_name | product_type | product_status |
|---:|---|---|---|---|
| 1 | PRD001 | 面部护理 | 护理项目 | ACTIVE |
| 2 | PRD005 | 基础护理 | 护理项目 | ACTIVE |

## 6. `customers` - customer profile and customer-home totals

This table matches the customer profile page. There is no customer phone,
product price, or recharge amount field.

| Field | Meaning | Example |
|---|---|---|
| `id` | Internal customer ID | `1` |
| `customer_code` | Auto-generated customer code | `CUS202608160001` |
| `customer_name` | Customer name | `陈晓` |
| `birth_date` | Birthday | `1995-06-18` |
| `notes` | Customer notes; default is empty | `` |
| `profile_photo_file_id` | Private CloudBase photo file ID | `cloud://.../customer/1.jpg` |
| `face_person_id` | Tencent face-library person ID | `cus_000001` |
| `created_store_id` | Store owning the customer | `1` |
| `customer_status` | `ACTIVE` or `ARCHIVED` | `ACTIVE` |
| `customer_process_status` | Business stage | `RECHARGED_WITH_CONSUMPTION` |
| `total_recharge_count` | Total approved recharge units | `16` |
| `total_verification_count` | Total approved verification units | `5` |
| `total_experience_count` | Approved experience verification units | `1` |
| `latest_recharge_at` | Latest approved recharge time | `2026-08-16 10:46` |
| `latest_verification_at` | Latest approved verification time | `2026-08-16 10:32` |
| `created_at` / `updated_at` | System timestamps | `2026-08-16 09:30` |

Business-stage values:

| Value | Page label |
|---|---|
| `INFORMATION_ONLY` | 有信息但没有充值 |
| `RECHARGED_NO_CONSUMPTION` | 已充值但没有消费 |
| `RECHARGED_WITH_CONSUMPTION` | 已充值并已有消费 |

| id | customer_code | customer_name | created_store_id | process status | recharge / verification / experience |
|---:|---|---|---:|---|---|
| 1 | CUS202608160001 | 陈晓 | 1 | RECHARGED_WITH_CONSUMPTION | 16 / 5 / 1 |

## 7. `operation_store_scopes` - legacy operation audit scope

This legacy table remains only to preserve historic account-to-store audit
references. Migration 047 archives every remaining row and blocks a new active
scope; it grants no current account any access.

| Field | Meaning | Example |
|---|---|---|
| `id` | Internal scope ID | `1` |
| `operation_account_id` | Historical operation account ID | `2` |
| `store_id` | Permitted store ID | `1` |
| `scope_status` | Historical row status; `ARCHIVED` after 047 | `ARCHIVED` |
| `created_at` / `updated_at` | System timestamps | `2026-08-16 09:40` |

| operation_account_id | store_id | scope_status |
|---:|---:|---|
| 2 | 1 | ARCHIVED |

## 8. `recharge_records` - recharge work orders

One row is one recharge order. The order page can show the order number, store,
customer, product, teacher, count, submission time, review time, status, and
messages. No money field is stored.

| Field | Meaning | Example |
|---|---|---|
| `id` | Internal order ID | `1` |
| `recharge_code` | Auto-generated recharge order number | `RC202608160001` |
| `recharge_type` | `NEW` or `VOID` | `NEW` |
| `original_recharge_id` | Original order when type is `VOID` | `NULL` |
| `store_id` | Related store | `1` |
| `teacher_id` | Optional related business teacher | `NULL` |
| `customer_id` | Related customer | `1` |
| `product_id` | Related product | `1` |
| `unit_count` | Recharge units, not money | `10` |
| `record_status` | `PENDING`, `APPROVED`, or `REJECTED` | `PENDING` |
| `submitted_by_account_id` | Account that submitted the order | `4` |
| `submitted_at` | Submission time | `2026-08-16 10:46` |
| `reviewed_by_account_id` | HQ reviewer account | `NULL` |
| `reviewed_at` | Review time | `NULL` |
| `message` | Submitter message; default is empty | `` |
| `review_note` | HQ review note; default is empty | `` |
| `created_at` / `updated_at` | System timestamps | `2026-08-16 10:46` |

| recharge_code | type | store | teacher | customer | product | units | status |
|---|---|---|---|---|---|---:|---|
| RC202608160001 | NEW | STR001 | TCH001 | CUS202608160001 | PRD001 | 10 | PENDING |

## 9. `verification_records` - verification work orders

One row is one verification order. Its workflow status is separate from its
verification type.

| Field | Meaning | Example |
|---|---|---|
| `id` | Internal order ID | `1` |
| `verification_code` | Auto-generated verification order number | `VX202608160001` |
| `verification_type` | `NORMAL`, `SUPPLEMENT`, or `EXPERIENCE` | `SUPPLEMENT` |
| `store_id` / `teacher_id` / `customer_id` / `product_id` | Related business entities | `1 / 1 / 1 / 1` |
| `unit_count` | Verification units; fixed at one per order | `1` |
| `record_status` | `PENDING`, `APPROVED`, `REJECTED`, or `VOIDED` | `PENDING` |
| `submitted_by_account_id` | Submitting account | `3` |
| `submitted_at` | Submission time | `2026-08-16 10:32` |
| `reviewed_by_account_id` / `reviewed_at` | HQ review information | `NULL / NULL` |
| `message` | General message; default is empty | `` |
| `supplement_note` | Required only when the type is `SUPPLEMENT` | `客户到店后补录` |
| `review_note` | HQ review note; default is empty | `` |
| `void_note` | Void explanation on the same original order | `` |
| `voided_by_account_id` / `voided_at` | Account and time that voided an approved order | `NULL / NULL` |
| `face_request_id` | Optional Tencent face request ID | `req_xxx` |
| `created_at` / `updated_at` | System timestamps | `2026-08-16 10:32` |

| verification_code | type | store | teacher | customer | product | units | status |
|---|---|---|---|---|---|---:|---|
| VX202608160001 | SUPPLEMENT | STR001 | TCH001 | CUS202608160001 | PRD001 | 1 | PENDING |

## 10. `customer_product_balances` - per-product count summary

This table drives the project count table on the customer home page. It is
automatically recalculated after an order changes, so it is never entered by a
staff member.

| Field | Meaning | Example |
|---|---|---|
| `customer_id` | Customer | `1` |
| `product_id` | Product | `1` |
| `total_recharge_count` | Net approved purchased units (`NEW` minus approved `VOID`) | `10` |
| `total_verification_count` | Approved consumptive units; only `NORMAL` and `SUPPLEMENT` | `4` |
| `remaining_count` | Purchased minus consumptive verification units | `6` |
| `updated_at` | Last automatic calculation time | `2026-08-16 10:32` |

| customer | product | recharge units | verification units | remaining units |
|---|---|---:|---:|---:|
| CUS202608160001 | PRD001 | 10 | 4 | 6 |
| CUS202608160001 | PRD005 | 6 | 1 | 5 |

`PENDING`, `REJECTED`, and `VOIDED` orders never consume a purchased unit.
`EXPERIENCE` also never consumes one. Voiding the original approved `NORMAL`
or `SUPPLEMENT` row therefore restores its units to `remaining_count`; voiding
an `EXPERIENCE` row restores zero. The database locks the customer row while
rebuilding the balance, so concurrent approvals or void retries cannot change
the count twice.

## 11. `record_status_history` - review history

This is the audit trail. It records status changes on the original recharge or
verification order. It does not create an extra approval order.

| Field | Meaning | Example |
|---|---|---|
| `id` | Internal history ID | `1` |
| `record_type` | `RECHARGE` or `VERIFICATION` | `RECHARGE` |
| `record_id` | Original order ID | `1` |
| `previous_status` | Status before the change | `PENDING` |
| `current_status` | Status after the change, including `VOIDED` | `APPROVED` |
| `changed_by_account_id` | Account changing the status | `1` |
| `change_note` | Review explanation; default is empty | `资料核对无误` |
| `changed_at` | Change time | `2026-08-16 11:00` |

| record_type | record_id | previous_status | current_status | changed_by_account_id |
|---|---:|---|---|---:|
| RECHARGE | 1 | PENDING | APPROVED | 1 |

## Automatic rules in the rebuild script

1. Store, teacher, product, customer, recharge, verification, and account
   codes are generated automatically.
2. Master records use only `ACTIVE` and `ARCHIVED`.
3. An archived account cannot sign in.
4. A customer can receive an order only from the store bound to that customer.
5. A customer profile can never contain a negative per-product remaining count.
6. Approved recharge and verification orders automatically update customer
   totals, recent business times, business stage, and the per-product summary.
7. The customer row is locked during recalculation so approvals for the same
   customer are serialized under concurrent requests.
8. RLS makes browser clients read-only and limits every read by the signed-in
   account's role. Cloud Functions perform all create, update, review, and
   archive operations with trusted server-side access.
