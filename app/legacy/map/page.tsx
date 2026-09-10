import LegacyApp from "@/components/legacy/LegacyApp";
import { ProductShell } from "@/components/product/ProductShell";

export default function LegacyMapPage() {
  return <ProductShell active="/map"><div className="legacy-map-shell"><LegacyApp mode="map" /></div></ProductShell>;
}
