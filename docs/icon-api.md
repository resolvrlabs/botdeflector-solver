# Resolvr icon API

The `botdeflector_image` task of the Resolvr API solves a BotDeflector icon challenge from its two images. The task returns the three clicks that answer the challenge, in click order.

The task is a recognition task. The client fetches the challenge in its own session and sends only the two images. Resolvr loads no page and uses neither a proxy nor a browser. A task therefore completes in well under one second, and its answer is not bound to an IP address. The client fetches the challenge and submits the clicks from its own session.

The API is asynchronous. The client submits a task, receives a `task_id` immediately, and then requests the result:

```
POST /v1/task        →  202 Accepted   { "task_id": "...", "status": "queued" }
GET  /v1/task/{id}   →  200 OK         { "status": "completed", "data": { ... } }
GET  /v1/balance     →  200 OK         { "balance": 48.9123, "currency": "USD" }
```

## Authentication

| | |
| --- | --- |
| Base URL | `https://api.resolvr.com`, with every endpoint under `/v1` |
| Authentication header | `Authorization: Bearer <YOUR_API_KEY>` ([obtain a key](https://resolvr.com/?ref=github)) |
| Content type | `application/json` |

A request without a valid `Authorization` header receives the response `401 ERROR_UNAUTHORIZED`. A key that is restricted to particular task types or source IP addresses receives `403 ERROR_TYPE_NOT_ALLOWED` or `403 ERROR_IP_NOT_ALLOWED` outside those restrictions.

The request `GET /v1/balance` returns the account balance, for example `{ "balance": 48.9123, "currency": "USD" }`. The balance is stated in US dollars with up to six decimal places and is the amount against which the next submission is charged. Because the balance already excludes the tasks in progress, it can be slightly lower than a settled total shown elsewhere.

## Submitting a task

A task is submitted with `POST https://api.resolvr.com/v1/task`:

```bash
curl -s https://api.resolvr.com/v1/task \
  -H "Authorization: Bearer $RESOLVR_API_KEY" \
  -H "Content-Type: application/json" \
  -d @- <<EOF
{
  "type": "botdeflector_image",
  "params": {
    "icons": "$(base64 < icon.png | tr -d '\n')",
    "background": "$(base64 < bg.webp | tr -d '\n')"
  }
}
EOF
```

| Field | Content |
| --- | --- |
| `type` | `"botdeflector_image"` |
| `params.icons` | The icon strip from `/icons/{lib}/ico/{ico}`, encoded in base64: a PNG image of 86 × 27 pixels that shows three icons from left to right, in click order |
| `params.background` | The background from `/icons/{lib}/bgnd/{img}`, encoded in base64: a WebP image of 300 × 200 pixels |

The fields `lib`, `ico` and `img` are part of the payload of the challenge token that `icon/get` returns. Each image is sent as plain base64, in the standard or the URL-safe alphabet and with or without padding, or as a `data:` URI (`data:image/png;base64,...` or `data:image/webp;base64,...`).

**Both images must be sent exactly as the challenge host served them.** The answer is derived from the pixels, and an image that has been re-encoded, resized or converted constitutes a different challenge. The request contains nothing else: no token, no cookie and no URL. The fields `url`, `proxy` and `cookies` are ignored if they are present, and the fields `user_agent`, `egress` and `egress_client` are rejected with `ERROR_INVALID_INPUT`.

| Rule | Detail |
| --- | --- |
| `icons` is a PNG image and `background` is a WebP image | Any other format is rejected at submission |
| The strip measures at most 256 × 64 pixels and the background at most 600 × 400 pixels | A larger image is not a BotDeflector challenge, and the task fails with `ERROR_INVALID_INPUT` |
| The request body is at most 32 KB (32,768 bytes) | The body of a typical challenge is about 9 KB |

The captured challenge in [`poc/fixture`](../poc/fixture), which consists of `icon.png` and `bg.webp`, can be used for testing.

### Response: `202 Accepted`

```json
{ "task_id": "01KZPV5BGPVDTSNQCCQV2M7EF6", "status": "queued" }
```

## Retrieving the result

The result is retrieved with `GET https://api.resolvr.com/v1/task/{task_id}`, using the same `Authorization` header:

```bash
curl -s https://api.resolvr.com/v1/task/01KZPV5BGPVDTSNQCCQV2M7EF6 \
  -H "Authorization: Bearer $RESOLVR_API_KEY"
```

The endpoint uses **long polling with a window of up to 5 seconds**. If the task finishes within that window, the result is returned in the same response. Otherwise, the response contains the current status, and the client repeats the request. A BotDeflector task normally finishes within the first window, so a single request usually suffices.

- **The read timeout of the client must exceed 5 seconds; 10 seconds or more is recommended.** The server keeps the connection open while it waits, and a client with a shorter timeout aborts its own request and reports a failure that did not occur. The connection timeout can remain short. The waiting time cannot be configured per request.
- **The client should not pause between requests.** The waiting takes place on the server, so a pause on the client side adds latency without saving a request. The client should send the next request as soon as the previous one returns.

**Successful task**

```json
{
  "task_id": "01KZPV5BGPVDTSNQCCQV2M7EF6",
  "status": "completed",
  "success": true,
  "data": {
    "points": [
      { "x": 231, "y": 67 },
      { "x": 40, "y": 59 },
      { "x": 168, "y": 103 }
    ]
  },
  "timing": { "queued_ms": 1, "proxy_verify_ms": 0, "execution_ms": 9, "total_ms": 31 }
}
```

**Failed task**

```json
{
  "task_id": "01KZPV5BGPVDTSNQCCQV2M7EF6",
  "status": "failed",
  "success": false,
  "error": "ERROR_RECOGNITION_UNSOLVED",
  "message": "No confident answer for this challenge",
  "timing": { "queued_ms": 2, "proxy_verify_ms": 0, "execution_ms": 24, "total_ms": 301 }
}
```

| Field | Present | Content |
| --- | --- | --- |
| `task_id` | Always | The identifier of the submitted task |
| `status` | Always | `queued`, `processing`, `completed` or `failed` |
| `success` | Once the task has finished | `true` only if the status is `completed` |
| `data.points` | On success | The three clicks as `{ "x": int, "y": int }`, in the order of the strip from left to right, in the pixel coordinates of the background image, with (0, 0) at its top-left corner |
| `error`, `message` | On failure | The reason for the failure, as described below |
| `timing.queued_ms` | Once the task has finished | The time the task spent in the queue before the solving began |
| `timing.proxy_verify_ms` | Once the task has finished | Always `0`, because no proxy is verified for this task type |
| `timing.execution_ms` | Once the task has finished | The time spent solving |
| `timing.total_ms` | Once the task has finished | The time from submission until the result is read. This value grows while the client delays its request, so the solving time is better measured by `execution_ms`. |

The service returns an answer only when it is certain of it. A challenge that the service cannot resolve fails with `ERROR_RECOGNITION_UNSOLVED` instead of returning a guess. Because the same images always lead to the same outcome, the client should fetch a new challenge and submit that one instead. A task that the recognizer cannot answer within its deadline of a few seconds fails with `ERROR_RECOGNITION_BUSY` and is refunded.

The result of a finished task is retained for about 5 minutes. A request after that period receives `410 ERROR_TASK_EXPIRED`, so the client should read the result as soon as the task finishes.

## Billing and concurrency

A task is charged when it is submitted, at the price listed for the account in the task catalogue, and **refunded in full if it fails**, regardless of the reason. A submission that is rejected outright, for example because of invalid parameters, a task type that the key does not allow, or an insufficient balance, is never charged.

Each task occupies one of the account's concurrent task slots from its submission until its result is recorded, which usually takes well under one second. At high rates, the concurrency limit, rather than the solving time, determines how many tasks per second an account can run. The response `429 ERROR_CONCURRENCY_LIMIT` indicates that too many of the account's tasks are still being recorded. The client should retry after a short pause, or ask Resolvr for a higher limit.

## Errors

A request can fail in two ways. The submission can be rejected synchronously with an HTTP status, or the task can fail during solving and report the failure in its result. Every error carries a code and a human-readable `message`.

### Submission errors (HTTP status of `POST /v1/task`)

| HTTP | `error` | Meaning |
| --- | --- | --- |
| 400 | `ERROR_INVALID_INPUT` | The request failed validation; `message` names the field at fault |
| 400 | `ERROR_UNSUPPORTED_TYPE` | The task type is unknown or not offered to the account |
| 401 | `ERROR_UNAUTHORIZED` | The API key is missing or invalid |
| 402 | `ERROR_INSUFFICIENT_BALANCE` | The account balance is too low or, for a task type that only paid credit can pay for, the paid part of the balance is too low |
| 403 | `ERROR_TYPE_NOT_ALLOWED` | The API key is not permitted to use this task type |
| 403 | `ERROR_IP_NOT_ALLOWED` | The source IP address is not in the allowlist of the key |
| 403 | `ERROR_ACCOUNT_SUSPENDED`, `ERROR_SUBSCRIPTION_EXPIRED` | The state of the account does not permit the request |
| 404 | `ERROR_TASK_NOT_FOUND` | The `task_id` is unknown or belongs to another account |
| 410 | `ERROR_TASK_EXPIRED` | The result of the task is no longer retained, about 5 minutes after the task finished |
| 429 | `ERROR_CONCURRENCY_LIMIT` | Too many tasks are in progress; the client should retry after a short pause |
| 499 | `ERROR_CLIENT_DISCONNECTED` | The client closed the request |
| 500 | `ERROR_INTERNAL` | An unexpected server error occurred |
| 503 | `ERROR_SERVICE_UNAVAILABLE`, `ERROR_MAINTENANCE` | The recognizer cannot accept the task at the moment; the client should retry with backoff |

The validation messages for this task type are the following:

| `message` | Correction |
| --- | --- |
| `params.icons is required`, `params.background is required` | Send both images |
| `params.icons must be base64`, `params.background must be base64` | Encode the image bytes in base64, or send a `data:` URI |
| `params.icons must be a PNG image` | Send the strip exactly as the challenge host served it |
| `params.background must be a WebP image` | Send the background exactly as the challenge host served it |
| `Request body exceeds 32 KB` | Send only the two images, without conversion |
| `user_agent is not accepted for botdeflector_image tasks` | Remove `user_agent` |
| `Egress mode does not apply to botdeflector_image tasks` | Remove `egress` and `egress_client` |

### Task result errors (`status: "failed"`)

| `error` | Meaning | Recommended action |
| --- | --- | --- |
| `ERROR_RECOGNITION_UNSOLVED` | The service has no confident answer for this challenge | Request a new challenge from `icon/get`, because the same images always produce the same result |
| `ERROR_RECOGNITION_BUSY` | The recognizer had no time left for this challenge | Send the same images again while the challenge is still valid |
| `ERROR_INVALID_INPUT` | The images could not be read as this challenge, because one of them does not decode or is larger than a challenge image | Do not resend the same images. Verify that the client sends the images as served, then request a new challenge |
| `ERROR_INTERNAL` | The task could not be completed for another reason | Send the same images again, because the error is usually transient |

Every failed task is refunded.

## Using the answer

The client inserts `data.points` unchanged into the `icon/verify` request body, in the field `solution`, and sets the field `time` to the number of milliseconds elapsed since the `icon/get` request. Queue-it rejects `icon/verify` within 2.5 seconds of `icon/get`, and the API responds within milliseconds, so the submission and the result request both fit within that waiting period. If the page draws the background at a size other than 300 × 200 pixels, the client must scale the points accordingly.

[`poc/resolvr.ts`](../poc/resolvr.ts) implements the request with the retries described above, and [`poc/solve.ts`](../poc/solve.ts) shows the complete step.
