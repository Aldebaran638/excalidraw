import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { newEmbeddableElement, newElementWith } from "@excalidraw/element";
import { forkHtmlApps } from "../data/htmlApps";
import { sourceHash } from "../server/appSource";
import { captureEmbeddableSnapshots, prepareEmbeddableSnapshots, registerEmbeddableCapture } from "@excalidraw/excalidraw/scene/embeddableSnapshots";

const fixture = () => {
  const source='<h1>计数器</h1>';
  return newEmbeddableElement({type:"embeddable",x:10,y:20,width:700,height:480,strokeColor:"#000",backgroundColor:"transparent",customData:{htmlApp:{formatVersion:1,appId:randomUUID(),version:3,sourceHash:sourceHash(source),sourceSnapshot:source,runtimeVersion:2,title:"计数器",state:{forms:{},custom:{count:2}}},embeddable:{snapshotRequired:true,snapshot:'<svg xmlns="http://www.w3.org/2000/svg" width="700" height="480"/>'}}});
};
it("forks source identity and deep state without modifying original geometry or previous elements",()=>{
  const original=fixture();
  const fork=forkHtmlApps([original])[0];
  expect(fork.customData!.htmlApp.appId).not.toBe(original.customData!.htmlApp.appId);
  expect(fork.customData!.htmlApp.version).toBe(1);
  expect(fork.customData!.htmlApp.pendingSource).toBe(true);
  expect([fork.x,fork.y,fork.width,fork.height]).toEqual([original.x,original.y,original.width,original.height]);
  fork.customData!.htmlApp.state.custom.count=9;
  expect(original.customData!.htmlApp.state.custom.count).toBe(2);
  expect(forkHtmlApps([original],new Set([original.id]))[0]).toBe(original);
});
it("rebases a saved copy's identity onto current edits rather than restoring the old scene",()=>{
  const original=fixture();
  const saved=forkHtmlApps([original])[0];
  const live=newElementWith(original,{x:333,customData:{...original.customData,htmlApp:{...original.customData!.htmlApp,state:{forms:{},custom:{count:8}}}}});
  const copy=forkHtmlApps([live],new Set(),new Map([[saved.id,saved.customData!.htmlApp.appId]]))[0];
  expect(copy.x).toBe(333);
  expect(copy.customData!.htmlApp.state.custom.count).toBe(8);
  expect(copy.customData!.htmlApp.appId).toBe(saved.customData!.htmlApp.appId);
  expect(copy.customData!.htmlApp.appId).not.toBe(original.customData!.htmlApp.appId);
});
it("captures fresh embedded content for both export paths and never falls back after capture failure",async()=>{
  const element=fixture();
  let frame=0;
  registerEmbeddableCapture(element.id,async()=>`<svg xmlns="http://www.w3.org/2000/svg" width="700" height="480"><text>${++frame}</text></svg>`);
  try {
    await captureEmbeddableSnapshots([element]);
    let prepared=prepareEmbeddableSnapshots([element],{});
    expect(prepared.elements[0].type).toBe("image");
    expect(decodeURIComponent(Object.values(prepared.files)[0].dataURL)).toContain("<text>1</text>");
    await captureEmbeddableSnapshots([element]);
    prepared=prepareEmbeddableSnapshots([element],{});
    expect(decodeURIComponent(Object.values(prepared.files)[0].dataURL)).toContain("<text>2</text>");
    registerEmbeddableCapture(element.id,async()=>{throw new Error("快照失败");});
    await expect(captureEmbeddableSnapshots([element])).rejects.toThrow("快照失败");
    registerEmbeddableCapture(element.id,null);
    await expect(captureEmbeddableSnapshots([element])).rejects.toThrow("尚未启动");
  } finally { registerEmbeddableCapture(element.id,null); }
});
