# Event maps & venue location

## What it does

- **Organizers.** The create and edit event forms have a *Venue & location* section:
  - **Search.** An explicit search (button or Enter) of Kenyan places through `/api/geocode`.
  - **Pick a result.** This fills the venue name, address and city only where those fields are
    empty. A separate "Replace…" action overwrites them deliberately.
  - **Place the pin.** Click the map, drag the pin, or pan with the keyboard and use
    *Set pin at map centre*.
  - **Confirm.** The organizer must press **Confirm pin** before the form saves, because the
    geocoded point is only a starting guess, not the entrance.
  - **Arrival instructions.** An optional free-text field for entrances, gates and parking.
- **Customers.**
  - The event page has a lazy-loaded Leaflet map (it loads when scrolled into view). The marker
    sits at the saved pin. Scroll-wheel zoom is off; the zoom buttons, pinch, drag and keyboard
    controls all work.
  - **Get directions** opens `https://www.google.com/maps/dir/?api=1&destination=<lat>,<lng>`
    using the exact saved pin. It never asks for the customer's location.
- **Tickets and email.** Each PDF page shows the venue and address, a clickable *Get directions*
  link annotation, the GPS coordinates and the arrival instructions. The confirmation email
  includes the full address, a directions link and the arrival instructions. Ticket codes and
  QR codes don't change when a location is edited; PDFs render on demand from the current event data.
- **No pin.** Events without a pin (legacy events) show the address, a "not pinned yet" notice
  and an *approximate* Google Maps search link. There's no map, no marker and no directions
  button. Such events can still be edited but can't be published until they're pinned.

## Data model (migrations `0001_event_location`, `0002_event_location_check`)

New nullable columns on `events`:
- `latitude` and `longitude` (`double precision`, rounded to 6 dp, about 11 cm)
- `location_provider` (`nominatim` | `manual`) and `location_place_id` (e.g. `osm:node:…`)
- `location_confirmed_at`
- `arrival_instructions` (`text`, default `''`)

CHECK `events_coordinates_valid` requires both coordinates or neither, within the valid ranges.
`(0, 0)` is rejected by the application. Both migrations are additive: existing events keep
NULL coordinates and stay valid.

Rules (enforced server-side in `saveEventAction`, `createEvent`, `updateEvent` and `publishEvent`):
- New events need a confirmed pin.
- A pin can be moved but not removed. Moves are audit-logged with their old and new coordinates.
- Publishing requires a valid pin.
- Only the owning organizer (or an admin) can change a location; the event is resolved through
  `requireOwnedEvent` before any parsing.

## Providers, limits and licensing

| Purpose | Default | Limits / terms |
|---|---|---|
| Venue search | Public **Nominatim** (`GEOCODER_URL`) | [Usage policy](https://operations.osmfoundation.org/policies/nominatim/): **≤ 1 request/second**, a descriptive User-Agent with contact details, **no autocomplete**, cache results, no bulk use. We comply by searching only on submit, serialising calls at least 1.1 s apart, caching for 24 h in memory, a 20 searches/min/user limit, and organizer-only access. **Not suitable for production volume**: self-host Nominatim or use a commercial Nominatim-compatible API (e.g. LocationIQ, OpenCage/Geoapify with an adapter). |
| Map tiles | `tile.openstreetmap.org` | [Tile usage policy](https://operations.osmfoundation.org/policies/tiles/): light use only, attribution required, no heavy or commercial-scale traffic. For production set `NEXT_PUBLIC_MAP_TILE_URL` (and `NEXT_PUBLIC_MAP_ATTRIBUTION`) to a provider such as MapTiler, Stadia Maps or Thunderforest. Their keys are *public, domain-restricted* keys. |
| Directions | Google Maps URLs (`maps/dir/?api=1`) | No API key, no billing; simply opens Google Maps. |
| Map library | Leaflet 1.9.4 (BSD-2) | Attribution: "Leaflet" plus "© OpenStreetMap contributors" (ODbL), shown on every map. |

OSM data quality varies across Kenya. Some well-known venues are only findable by their local
name (e.g. "KICC" works; the full "Kenyatta International Convention Centre" currently returns
nothing). That's why manual pin placement and confirmation are first-class.
