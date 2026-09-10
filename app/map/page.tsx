import { ProductShell } from "@/components/product/ProductShell";
import LegacyApp from "@/components/legacy/LegacyApp";

export default function Page() {
  return (
    <ProductShell active="/map">
      <div className="legacy-map-shell">
        <LegacyApp mode="map" />
      </div>
    </ProductShell>
  );
}
