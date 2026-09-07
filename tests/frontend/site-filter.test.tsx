import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import SiteFilter from "@/components/central/SiteFilter";
import type { SwapStation } from "@/lib/fleet";

afterEach(cleanup);

const sites: SwapStation[] = [
  { id: "pune-hub-plant", name: "Pune (Hub & Plant)", state: "Maharashtra", lat: 18.52, lon: 73.86, bays: 4, assetCount: 36 },
  { id: "udaipur", name: "Udaipur", state: "Rajasthan", lat: 24.59, lon: 73.71, bays: 4, assetCount: 13 },
];

describe("Central site selector", () => {
  it("is a clean single-site dropdown and emits one selected site", () => {
    const onChange = vi.fn();
    render(<SiteFilter sites={sites} selectedIds={[sites[0].id]} onChange={onChange} />);

    const select = screen.getByRole("combobox", { name: "Choose operating site" }) as HTMLSelectElement;
    expect(select.value).toBe("pune-hub-plant");
    expect(screen.getByText("36 assets")).toBeTruthy();
    expect(screen.queryByText("Select one or more sites to update the dashboard")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();

    fireEvent.change(select, { target: { value: "udaipur" } });
    expect(onChange).toHaveBeenCalledWith(["udaipur"]);
  });
});
