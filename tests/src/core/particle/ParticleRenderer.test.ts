import { WebGLEngine } from "@galacean/engine-rhi-webgl";
import { Camera, ParticleRenderer, ModelMesh } from "@galacean/engine-core";
import { expect } from "chai";

describe("ParticleRenderer", () => {
  let engine: WebGLEngine;

  before(async function () {
    engine = await WebGLEngine.create({
      canvas: document.createElement("canvas")
    });
    engine.canvas.resizeByClientSize();

    const rootEntity = engine.sceneManager.activeScene.createRootEntity("root");

    const cameraEntity = rootEntity.createChild("Camera");
    cameraEntity.addComponent(Camera);
    cameraEntity.transform.setPosition(0, 0, 10);

    engine.run();
  });

  it("refCount", () => {
    const scene = engine.sceneManager.activeScene;
    const renderer1 = scene.createRootEntity("Renderer").addComponent(ParticleRenderer);
    const mesh = new ModelMesh(engine, "mesh");
    renderer1.mesh = mesh;
    expect(mesh.refCount).to.eq(1);
    renderer1.mesh = null;
    expect(mesh.refCount).to.eq(0);
    renderer1.mesh = mesh;
    expect(mesh.refCount).to.eq(1);
    renderer1.mesh = undefined;
    expect(mesh.refCount).to.eq(0);
    renderer1.mesh = mesh;
    expect(mesh.refCount).to.eq(1);
    renderer1.destroy();
    expect(mesh.refCount).to.eq(0);

    const entity2 = scene.createRootEntity("entity2");
    entity2.addComponent(ParticleRenderer).mesh = mesh;
    entity2.destroy();
    expect(mesh.refCount).to.eq(0);

    const renderer2 = scene.createRootEntity("Renderer").addComponent(ParticleRenderer);
    renderer2.mesh = mesh;

    mesh.destroy();
    expect(mesh.refCount).to.eq(1);

    mesh.destroy(true);
    expect(mesh.refCount).to.eq(0);
  });
});
