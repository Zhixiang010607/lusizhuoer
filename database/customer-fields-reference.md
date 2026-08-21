# 客户表字段说明

表名：`public.customers`

本表只保存客户档案和客户汇总状态。每一笔充值、核销应分别保存到独立的记录表，通过 `customer_id` 关联客户。

| 字段名 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `id` | `BIGINT` | 自动生成 | 客户内部唯一 ID；主键。新建客户时不需要传入。 |
| `customer_code` | `VARCHAR(32)` | 无 | 对外展示的客户编号；由系统自动生成，必须唯一。 |
| `customer_name` | `VARCHAR(64)` | 无 | 客户真实姓名。 |
| `birth_date` | `DATE` | 无 | 客户生日，用于客户查询和身份核对。 |
| `notes` | `TEXT` | `''` | 特别注意事项；没有内容时保存空字符串。 |
| `created_store_id` | `BIGINT` | 无 | 客户绑定的门店 ID；关联 `public.stores.id`。一个客户归属一个建立门店。 |
| `customer_status` | `VARCHAR(16)` | `ACTIVE` | 客户档案状态，只允许活跃或已存档。 |
| `customer_process_status` | `VARCHAR(32)` | `INFORMATION_ONLY` | 客户业务阶段，由充值和核销结果自动变化。 |
| `total_recharge_count` | `INTEGER` | `0` | 客户累计审核通过的充值次数。作废、驳回和待审核不计入。 |
| `total_verification_count` | `INTEGER` | `0` | 客户累计审核通过的核销次数。普通核销和补录核销计入。 |
| `total_experience_count` | `INTEGER` | `0` | 客户累计审核通过的体验核销次数。仅核销标签为体验时计入。 |
| `profile_photo_file_id` | `VARCHAR(512)` | `NULL` | CloudBase 云存储的私有 `fileID`；不保存公开下载链接。 |
| `photo_captured_at` | `TIMESTAMPTZ` | `NULL` | 客户建档照片的实际拍摄时间。 |
| `face_person_id` | `VARCHAR(128)` | `NULL` | 腾讯云人脸库中的人员 ID；用于人脸识别和后续核销。 |
| `face_consent_at` | `TIMESTAMPTZ` | `NULL` | 客户授权采集建档照片和面容信息的确认时间。 |
| `created_at` | `TIMESTAMPTZ` | `NOW()` | 客户档案建立时间，由数据库自动写入。 |
| `updated_at` | `TIMESTAMPTZ` | `NOW()` | 客户档案最后更新时间。 |

## 客户状态

| 页面显示 | 数据库存值 | 含义 |
|---|---|---|
| 活跃 | `ACTIVE` | 客户档案正常可用。 |
| 已存档 | `ARCHIVED` | 客户档案保留历史资料，但不应继续作为新充值或核销的对象。 |

## 业务阶段

“全部客户”只是查询条件，不写入数据库。

| 页面显示 | 数据库存值 | 进入条件 |
|---|---|---|
| 有信息但没有充值 | `INFORMATION_ONLY` | 客户刚建立，尚无审核通过的充值。 |
| 已充值但没有消费 | `RECHARGED_NO_CONSUMPTION` | 至少有一笔审核通过的充值，但没有审核通过的核销。 |
| 已充值并已有消费 | `RECHARGED_WITH_CONSUMPTION` | 至少有一笔审核通过的核销。 |

## 汇总字段更新规则

1. 新建客户：三个总次数均为 `0`，业务阶段为 `INFORMATION_ONLY`。
2. 充值审核通过：`total_recharge_count` 加 `1`，业务阶段更新为 `RECHARGED_NO_CONSUMPTION`。
3. 普通或补录核销审核通过：`total_verification_count` 加 `1`，业务阶段更新为 `RECHARGED_WITH_CONSUMPTION`。
4. 体验核销审核通过：`total_verification_count` 与 `total_experience_count` 都加 `1`，业务阶段更新为 `RECHARGED_WITH_CONSUMPTION`。
5. 驳回、作废、待审核记录不计入总次数。若已经通过的记录之后被作废，应重新汇总客户总次数和业务阶段。

## 创建归属字段

客户档案同时保存两个不同含义的归属：

- `created_store_id`：客户所属门店；无论总部、门店还是老师创建，都必须绑定本次选择的真实门店。
- `created_by_account_id`：实际执行建档的登录账号。老师只能凭“该字段就是本人账号”立即查看自己建立的客户；门店账号建立时该字段保存门店账号，不会直接绑定任何老师。

历史客户在迁移 057 前没有记录创建账号，因此该字段保持 `NULL`，不能根据姓名、门店或时间猜测老师归属。老师仍可通过本人已经审核通过的正常／体验核销关系查看这些历史客户。
