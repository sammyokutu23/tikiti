/**
 * Approximate demo venue pins for seeded events (dev data only). The Rift Valley
 * Cycling Classic is intentionally left without a pin to demo the no-location fallback.
 */
export const DEMO_LOCATIONS: Record<string, { lat: number; lng: number; arrival?: string }> = {
  "afrosonic-live-nairobi": { lat: -1.32842, lng: 36.80402, arrival: "Enter through the main Carnivore gate on Langata Road. Secure parking KES 300." },
  "savannah-sound-festival-2026": { lat: -1.30686, lng: 36.74214, arrival: "Gate A on Ngong Road for ticket holders. Free shuttles drop off at Gate C." },
  "jazz-on-the-lawn": { lat: -1.27447, lng: 36.80703, arrival: "Use the Arboretum Drive entrance; limited parking inside." },
  "rooftop-amapiano-sundays": { lat: -1.29531, lng: 36.78653 },
  "open-mic-poetry-spoken-word": { lat: -1.28455, lng: 36.81783 },
  "watercolour-and-wine-westlands": { lat: -1.26432, lng: 36.80311 },
  "dance-kenya-showcase": { lat: -1.27924, lng: 36.81512 },
  "nairobi-tech-summit-2026": { lat: -1.28868, lng: 36.82361, arrival: "Badge collection at the Tsavo Ballroom foyer from 7:30 AM. Bring your ID." },
  "lake-naivasha-half-marathon": { lat: -0.75689, lng: 36.43196, arrival: "Race village opens 5:00 AM. Bib collection closes 6:00 AM." },
  "mombasa-beats-beach-party": { lat: -4.04473, lng: 39.71932 },
  "lakeside-comedy-night-kisumu": { lat: -0.09883, lng: 34.75762 },
  "diani-sunset-sessions": { lat: -4.31744, lng: 39.57839 },
};
