import { describe, expect, it } from "vitest";
import {
  decideAction,
  nextReconcileDelayMsForObservedStateForTest,
  processQueueWithConcurrencyForTest,
  resolveConfiguredExpectedRuntimeVersionForTest,
} from "./reconciler.js";

describe("decideAction", () => {
  it("returns create-vm when desired is running and instance is missing", () => {
    const action = decideAction({
      mode: "gce",
      deleted: false,
      desiredRunning: true,
      actualStatus: "MISSING",
      machineProfileMismatch: false,
      hasReachableIp: false,
      runtimeHealthy: null,
      startupTimedOut: false,
      needsUpgrade: false,
      runtimeVersionMismatch: false,
      runtimeVersionMatchesExpected: false,
    });

    expect(action).toEqual({ kind: "create-vm" });
  });

  it("returns suspend-vm when desired is stopped and instance is running", () => {
    const action = decideAction({
      mode: "gce",
      deleted: false,
      desiredRunning: false,
      actualStatus: "RUNNING",
      machineProfileMismatch: false,
      hasReachableIp: true,
      runtimeHealthy: true,
      startupTimedOut: false,
      needsUpgrade: false,
      runtimeVersionMismatch: false,
      runtimeVersionMatchesExpected: false,
    });

    expect(action).toEqual({ kind: "suspend-vm" });
  });

  it("marks stopped without suspending when VM is already suspended", () => {
    const action = decideAction({
      mode: "gce",
      deleted: false,
      desiredRunning: false,
      actualStatus: "SUSPENDED",
      machineProfileMismatch: false,
      hasReachableIp: false,
      runtimeHealthy: null,
      startupTimedOut: false,
      needsUpgrade: false,
      runtimeVersionMismatch: false,
      runtimeVersionMatchesExpected: false,
    });

    expect(action).toEqual({ kind: "mark-stopped" });
  });

  it("returns mark-running when VM is healthy and desired is running", () => {
    const action = decideAction({
      mode: "gce",
      deleted: false,
      desiredRunning: true,
      actualStatus: "RUNNING",
      machineProfileMismatch: false,
      hasReachableIp: true,
      runtimeHealthy: true,
      startupTimedOut: false,
      needsUpgrade: false,
      runtimeVersionMismatch: false,
      runtimeVersionMatchesExpected: false,
    });

    expect(action).toEqual({ kind: "mark-running", needsUpgrade: undefined });
  });

  it("does not recreate when startup timeout elapsed but runtime is healthy", () => {
    const action = decideAction({
      mode: "gce",
      deleted: false,
      desiredRunning: true,
      actualStatus: "RUNNING",
      machineProfileMismatch: false,
      hasReachableIp: true,
      runtimeHealthy: true,
      startupTimedOut: true,
      needsUpgrade: false,
      runtimeVersionMismatch: false,
      runtimeVersionMatchesExpected: true,
    });

    expect(action).toEqual({ kind: "mark-running", needsUpgrade: false });
  });

  it("returns delete-agent when row is tombstoned", () => {
    const action = decideAction({
      mode: "gce",
      deleted: true,
      desiredRunning: false,
      actualStatus: "TERMINATED",
      machineProfileMismatch: false,
      hasReachableIp: false,
      runtimeHealthy: null,
      startupTimedOut: false,
      needsUpgrade: false,
      runtimeVersionMismatch: false,
      runtimeVersionMatchesExpected: false,
    });

    expect(action).toEqual({ kind: "delete-agent" });
  });

  it("recreates VM when startup is timed out and VM stays unhealthy", () => {
    const action = decideAction({
      mode: "gce",
      deleted: false,
      desiredRunning: true,
      actualStatus: "RUNNING",
      machineProfileMismatch: false,
      hasReachableIp: true,
      runtimeHealthy: false,
      startupTimedOut: true,
      needsUpgrade: false,
      runtimeVersionMismatch: false,
      runtimeVersionMatchesExpected: false,
    });

    expect(action).toEqual({ kind: "recreate-vm" });
  });

  it("keeps starting when VM is running but health is not ready before timeout", () => {
    const action = decideAction({
      mode: "gce",
      deleted: false,
      desiredRunning: true,
      actualStatus: "RUNNING",
      machineProfileMismatch: false,
      hasReachableIp: true,
      runtimeHealthy: false,
      startupTimedOut: false,
      needsUpgrade: false,
      runtimeVersionMismatch: false,
      runtimeVersionMatchesExpected: false,
    });

    expect(action).toEqual({ kind: "mark-starting" });
  });

  it("keeps starting when VM has no reachable IP even after startup timeout", () => {
    const action = decideAction({
      mode: "gce",
      deleted: false,
      desiredRunning: true,
      actualStatus: "RUNNING",
      machineProfileMismatch: false,
      hasReachableIp: false,
      runtimeHealthy: null,
      startupTimedOut: true,
      needsUpgrade: false,
      runtimeVersionMismatch: false,
      runtimeVersionMatchesExpected: false,
    });

    expect(action).toEqual({ kind: "mark-starting" });
  });

  it("marks stopped while desired is stopped and VM is suspending", () => {
    const action = decideAction({
      mode: "gce",
      deleted: false,
      desiredRunning: false,
      actualStatus: "SUSPENDING",
      machineProfileMismatch: false,
      hasReachableIp: true,
      runtimeHealthy: null,
      startupTimedOut: false,
      needsUpgrade: false,
      runtimeVersionMismatch: false,
      runtimeVersionMatchesExpected: false,
    });

    expect(action).toEqual({ kind: "mark-stopped" });
  });

  it("marks running with needs_upgrade=true when runtime version mismatches", () => {
    const action = decideAction({
      mode: "gce",
      deleted: false,
      desiredRunning: true,
      actualStatus: "RUNNING",
      machineProfileMismatch: false,
      hasReachableIp: true,
      runtimeHealthy: true,
      startupTimedOut: false,
      needsUpgrade: true,
      runtimeVersionMismatch: true,
      runtimeVersionMatchesExpected: false,
    });

    expect(action).toEqual({ kind: "mark-running", needsUpgrade: true });
  });

  it("recreates instead of starts when VM is stopped and upgrade is required", () => {
    const action = decideAction({
      mode: "gce",
      deleted: false,
      desiredRunning: true,
      actualStatus: "SUSPENDED",
      machineProfileMismatch: false,
      hasReachableIp: false,
      runtimeHealthy: null,
      startupTimedOut: false,
      needsUpgrade: true,
      runtimeVersionMismatch: false,
      runtimeVersionMatchesExpected: false,
    });

    expect(action).toEqual({ kind: "recreate-vm" });
  });

  it("starts suspended VM when upgrade is not required", () => {
    const action = decideAction({
      mode: "gce",
      deleted: false,
      desiredRunning: true,
      actualStatus: "SUSPENDED",
      machineProfileMismatch: false,
      hasReachableIp: false,
      runtimeHealthy: null,
      startupTimedOut: false,
      needsUpgrade: false,
      runtimeVersionMismatch: false,
      runtimeVersionMatchesExpected: false,
    });

    expect(action).toEqual({ kind: "start-vm" });
  });

  it("recreates suspended VM when runtime version is unknown under enforcement", () => {
    const action = decideAction({
      mode: "gce",
      deleted: false,
      desiredRunning: true,
      actualStatus: "SUSPENDED",
      machineProfileMismatch: false,
      hasReachableIp: false,
      runtimeHealthy: null,
      startupTimedOut: false,
      needsUpgrade: true,
      runtimeVersionMismatch: true,
      runtimeVersionMatchesExpected: false,
    });

    expect(action).toEqual({ kind: "recreate-vm" });
  });

  it("recreates when running VM machine profile mismatches desired profile", () => {
    const action = decideAction({
      mode: "gce",
      deleted: false,
      desiredRunning: true,
      actualStatus: "RUNNING",
      machineProfileMismatch: true,
      hasReachableIp: true,
      runtimeHealthy: true,
      startupTimedOut: false,
      needsUpgrade: false,
      runtimeVersionMismatch: false,
      runtimeVersionMatchesExpected: true,
    });

    expect(action).toEqual({ kind: "recreate-vm" });
  });

  it("recreates when stopped VM machine profile mismatches desired profile", () => {
    const action = decideAction({
      mode: "gce",
      deleted: false,
      desiredRunning: true,
      actualStatus: "TERMINATED",
      machineProfileMismatch: true,
      hasReachableIp: false,
      runtimeHealthy: null,
      startupTimedOut: false,
      needsUpgrade: false,
      runtimeVersionMismatch: false,
      runtimeVersionMatchesExpected: false,
    });

    expect(action).toEqual({ kind: "recreate-vm" });
  });
});

describe("resolveConfiguredExpectedRuntimeVersionForTest", () => {
  it("accepts explicit versions with allowed characters", () => {
    expect(
      resolveConfiguredExpectedRuntimeVersionForTest(" 1bcc1e722643 "),
    ).toBe("1bcc1e722643");
    expect(
      resolveConfiguredExpectedRuntimeVersionForTest("manual-20260228044454"),
    ).toBe("manual-20260228044454");
    expect(resolveConfiguredExpectedRuntimeVersionForTest("v1.2.3_alpha")).toBe(
      "v1.2.3_alpha",
    );
  });

  it("disables enforcement for empty value", () => {
    expect(resolveConfiguredExpectedRuntimeVersionForTest("")).toBeNull();
    expect(resolveConfiguredExpectedRuntimeVersionForTest("   ")).toBeNull();
  });

  it("disables enforcement for latest mode in phase 1", () => {
    expect(resolveConfiguredExpectedRuntimeVersionForTest("latest")).toBeNull();
    expect(resolveConfiguredExpectedRuntimeVersionForTest("LATEST")).toBeNull();
  });

  it("disables enforcement for invalid characters", () => {
    expect(
      resolveConfiguredExpectedRuntimeVersionForTest("bad version"),
    ).toBeNull();
    expect(
      resolveConfiguredExpectedRuntimeVersionForTest("runtime@1"),
    ).toBeNull();
  });
});

describe("processQueueWithConcurrencyForTest", () => {
  it("does not let one slow item block another item", async () => {
    const startedAt = Date.now();
    let fastFinishedAt = 0;

    await processQueueWithConcurrencyForTest(
      ["slow", "fast"],
      2,
      async (item) => {
        if (item === "slow") {
          await new Promise((resolve) => setTimeout(resolve, 300));
          return;
        }
        fastFinishedAt = Date.now();
      },
    );

    expect(fastFinishedAt).toBeGreaterThanOrEqual(startedAt);
    expect(fastFinishedAt - startedAt).toBeLessThan(250);
  });
});

describe("reconcile scheduling", () => {
  it("requeues starting state faster than steady states", () => {
    const startingDelay =
      nextReconcileDelayMsForObservedStateForTest("starting");
    const runningDelay = nextReconcileDelayMsForObservedStateForTest("running");
    const stoppedDelay = nextReconcileDelayMsForObservedStateForTest("stopped");

    expect(startingDelay).toBe(2_000);
    expect(runningDelay).toBeGreaterThan(startingDelay);
    expect(stoppedDelay).toBeGreaterThan(startingDelay);
  });
});
