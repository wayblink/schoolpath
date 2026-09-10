import { ProductShell } from "@/components/product/ProductShell";
import { PolicyExplorer } from "@/components/product/PolicyExplorer";
import { getPolicies } from "@/lib/product/queries";

export const dynamic = "force-dynamic";

export default async function Page() {
  const policies = await getPolicies();
  return <ProductShell active="/sources"><main className="product-page"><header className="page-intro"><span>04 · 信息源</span><h1>核对区级政策与学校招生记录</h1><p>这里集中展示当前 {policies.length.toLocaleString()} 条信息源：区级政策说明全区规则，学校招生记录保留具体学校的招生信息与来源。</p></header><PolicyExplorer policies={policies}/></main></ProductShell>;
}
