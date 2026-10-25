import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { can } from "@/lib/auth/access";
import { NoAccess } from "@/components/NoAccess";
import { requireUser } from "@/lib/server";
import { monthParam, visibleInvestors, visibleProperties } from "@/lib/queries";
import { isPropertyMonthLocked } from "@/lib/services/settlement";
import { previousMonthTargets, targetsForMonth } from "@/lib/services/targets";
import { MonthNav } from "@/components/MonthNav";
import { TargetsForm, type TargetsInvestor } from "@/components/TargetsForm";
import { saveTargetsAction } from "./actions";

export default async function Targets({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  if (!can(user, "admin")) return <NoAccess />;
  const db = getDb();
  const month = monthParam(sp.month);
  const [invs, props, current, previous] = await Promise.all([
    visibleInvestors(db, user),
    visibleProperties(db, user),
    targetsForMonth(db, user, month),
    previousMonthTargets(db, user, month),
  ]);
  const active = props.filter((p) => p.active);
  const locked = Object.fromEntries(await Promise.all(active.map(async (p) => [p.id, await isPropertyMonthLocked(db, p.id, month)] as const)));
  const investors: TargetsInvestor[] = invs
    .map((i) => ({
      id: i.id,
      name: i.name,
      props: active
        .filter((p) => p.investorId === i.id)
        .map((p) => ({ id: p.id, name: p.name, avail: D.availableNights(p.rooms, D.firstDay(month), D.lastDay(month)), locked: locked[p.id] })),
    }))
    .filter((i) => i.props.length);

  return (
    <>
      <div className="topbar">
        <h1>Chỉ tiêu tháng</h1>
        <MonthNav month={month} path="/targets" />
        <p className="sub">Nhập doanh thu, công suất và giá trung bình mục tiêu cho từng cơ sở. Trang Tổng quan dùng các số này để tính tiến độ KPI.</p>
      </div>
      {investors.length ? (
        // key theo tháng để đổi tháng thì form nạp lại số của tháng đó
        <TargetsForm key={month} month={month} investors={investors} current={current} previous={previous} action={saveTargetsAction} />
      ) : (
        <div className="panel empty">Chưa có cơ sở nào đang hoạt động. Thêm cơ sở ở mục Cơ sở và phòng.</div>
      )}
    </>
  );
}
