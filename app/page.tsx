import { redirect } from "next/navigation";

/** The product has one entry point: the Central Dashboard. */
export default function RootPage() {
  redirect("/digital-twin/central");
}
