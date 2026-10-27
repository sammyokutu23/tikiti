import { permanentRedirect } from "next/navigation";

/** The outside-ticket form now lives on /resale/sell itself. */
export default function SellOutsideTicketPage() {
  permanentRedirect("/resale/sell");
}
