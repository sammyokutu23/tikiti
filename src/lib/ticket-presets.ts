/** Common ticket types organizers can add by entering just a price and quantity. */
export const TICKET_PRESETS = [
  { key: "early", name: "Early Bird", description: "Limited tickets at a lower price for early buyers.", capacity: 50 },
  { key: "regular", name: "Regular", description: "", capacity: 200 },
  { key: "vip", name: "VIP", description: "Priority entry and a VIP area.", capacity: 50 },
  { key: "vvip", name: "VVIP", description: "Premium access with the best spots.", capacity: 20 },
  { key: "student", name: "Student", description: "Valid student ID required at the gate.", capacity: 50 },
  { key: "child", name: "Kids", description: "For children under 12.", capacity: 50 },
  { key: "free", name: "Free entry", description: "", capacity: 100, free: true },
] as const satisfies readonly { key: string; name: string; description: string; capacity: number; free?: boolean }[];

export type TicketPresetKey = (typeof TICKET_PRESETS)[number]["key"];
