import { ProductShell } from "@/components/product/ProductShell";
import MapWorkspace from "@/components/map/MapWorkspace";

export default function Page() {
  return (
    <ProductShell active="/map">
      <div className="map-shell">
        <MapWorkspace mode="map" />
      </div>
    </ProductShell>
  );
}
