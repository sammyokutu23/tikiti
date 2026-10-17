# AI Banner Studio

Organizers generate event artwork with OpenAI, preview it with their **real** event details, and
download it or save it as the event cover. Manual upload keeps working unchanged.

Code: `src/server/banners/`:
- `prompt.ts`: styles, formats and the prompt builder
- `openai.ts`: the server-only API adapter and error mapping
- `compose.tsx`: cropping and text overlay
- `service.ts`: limits, generation, storage and saving

The UI is at `/organizer/events/<id>/banner`. Use **Create with AI** in the event editor or **AI
banner** on the event page.

## Setup

```
OPENAI_API_KEY=sk-...            # server-only; never NEXT_PUBLIC_
OPENAI_IMAGE_MODEL=gpt-image-2.5-flare
OPENAI_IMAGE_QUALITY=medium      # low | medium | high | auto
```

- **Model:** pick a current GPT Image model from the official docs
  (https://developers.openai.com/api/docs/guides/image-generation). It's configuration, not code;
  the server only checks the name starts with `gpt-image-`. GPT Image models need **OpenAI
  organization verification** on your OpenAI account.
- **Without these variables** the Studio shows "AI generation isn't set up yet" and organizers can
  still upload images.
- **Status:** **Admin → AI banners** shows whether OpenAI is configured, without ever showing the
  key.
- **Storage:** generated images are stored with the existing storage driver. Use
  `STORAGE_DRIVER=supabase` in production (see [PRODUCTION.md](PRODUCTION.md)); the local disk is
  dev-only.

## How it works

1. **Generate.** The organizer chooses the following, then generates 1 to *max* concepts:
   - a category;
   - a description ("the vibe", up to 600 characters);
   - one of 8 styles: premium nightlife, music concert, beach party, Afro-tropical,
     corporate/professional, minimal & elegant, bold & energetic, festival/outdoor;
   - a shape;
   - an optional refinement.
2. **The prompt.** The server builds a structured prompt that asks for **text-free** artwork with
   calm space for an overlay.
   - The event title is **not** sent: image models misspell text, and the real title is added later.
   - Links, emails and phone numbers are stripped from the description.
   - The request goes to the Image API (`images.generate`) with `output_format: "jpeg"`,
     `moderation: "auto"` and a hashed per-organizer `user` id.
3. **Sizes.** We request only `1536x1024`, `1024x1024` or `1024x1536`, the three sizes every GPT
   Image model supports.
4. **Validation and storage.** The output is checked by its file signature, re-encoded with `sharp`
   (which strips metadata and caps the size), and stored as background artwork.
5. **Preview.** `GET /api/organizer/events/<id>/banner` composes on the server.
   - It crops to the format with `sharp`, using attention-based cover.
   - It overlays text with our own typography (Geist via `next/og`/satori): the title, date and
     time (in the event's time zone), venue, an optional "Get tickets on TikoSoko" button and the
     organizer name.
   - **Every string comes from the event row in the database**, never from the browser.
   - Formats:

     | Format | Size |
     |---|---|
     | Website banner, 16:9 | 1600×900 |
     | Square social, 1:1 | 1080×1080 |
     | Portrait poster, 2:3 | 1080×1620 |

   - For the 16:9 cover, text stays above the bottom 14 %, so the 16:7 and 16:10 crops used on the
     site keep it.
6. **Save as event cover.** This composes the 16:9 banner and stores it as a new file.
   - If the event already has a cover, the organizer must tick **Replace the current cover**.
   - The old file is never deleted, and its URL is recorded in the audit log
     (`event.cover_set_from_ai`).
   - Backgrounds and composed banners are separate files, so a banner can be re-composed later.

## Cost controls

**Admin → AI banners** sets these limits; they're stored in `platform_settings`, not hard-coded:

| Limit | Default |
|---|---|
| Images per organizer per 24 h | 6 |
| Images per organizer per 30 days | 40 |
| Platform images per 30 days | 500 |
| Images per request | 2 |
| Requests per user per minute | 3 |
| Enabled | yes |

- **Authorized users only.** Only signed-in organizers can generate, and only for events they own.
  Admins can generate for any event; the usage counts against the event's organizer.
- **One request at a time.** A unique index allows one generation in flight per organizer, so
  repeated clicks can't start parallel billed requests. A row stuck "pending" for more than 6
  minutes is marked abandoned.
- **Limits can't be bypassed.** Quota checks and the reservation run under a Postgres advisory lock,
  so concurrent requests can't both slip under a limit.
- **Failures aren't counted.** Failed requests (no image produced) don't count toward limits, and
  the Studio says so.
- **Usage is recorded.** Every request is stored in `banner_generations` with the model, style,
  format, size, quality, image count, status, error category and timestamps.
- **No pricing in code.** Actual cost is visible in your OpenAI usage dashboard.

## Errors

| Provider response | Category | Shown to the organizer | Retry? |
|---|---|---|---|
| `moderation_blocked` / `image_generation_user_error` | moderation | "This description can't be used… rephrase it" | No |
| 401 / 403 / 404 model | config | "AI banners are temporarily unavailable" | No |
| 429 `insufficient_quota` | quota | same | No |
| 429 rate limit | rate_limited | "The image service is busy" | Yes, manually |
| Timeout | timeout | "Image generation took too long" | Yes |
| 5xx / network | provider_unavailable | "The image service had a problem" | Yes |
| Non-image output | invalid_output | "The generated image was invalid" | Yes |

Raw provider messages, prompts and keys are never sent to the browser or stored in error fields.

## Safety

- **The key stays on the server.** It's read only in `server/banners/openai.ts`, never logged, and
  never in a `NEXT_PUBLIC_` variable or an API response.
- **Organizers only see their own artwork.** The preview route and actions check event ownership,
  and artwork is looked up by generation id **and** event id, so one organizer can't render
  another's.
- **Usage guidance.** The Studio asks organizers not to describe real people, brands or copyrighted
  characters, and the prompt tells the model not to depict identifiable public figures.

## Testing

`npm test` runs `tests/banners.test.ts` (18 tests) with a **fake** generator. Covered:

- **Configuration:** validation, and refusing to generate when unconfigured.
- **Prompts:** sanitizing descriptions, and the event title never being sent.
- **Generation:** storage and usage records, the per-request cap, the daily limit (with failures not
  counted), the in-flight guard, the admin switch, the provider-error mapping, and rejecting
  non-image output.
- **Composition:** exact output sizes for all formats, artwork scoped to its own event, and replacing
  a cover only with confirmation and an audit entry.

These tests don't call OpenAI. To verify real generation:
1. Set the variables above.
2. Open the Studio for one of your events.
3. Generate one concept at `low` quality to keep the cost down.
