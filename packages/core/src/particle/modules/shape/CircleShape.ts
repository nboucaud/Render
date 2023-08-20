import { Rand, Vector2, Vector3 } from "@galacean/engine-math";
import { BaseShape } from "./BaseShape";
import { ShapeUtils } from "./ShapeUtils";
import { ParticleShapeMultiModeValue } from "./enums/ParticleShapeMultiModeValue";
import { ParticleShapeType } from "./enums/ParticleShapeType";

/**
 * Circle Particle Emitter
 */
export class CircleShape extends BaseShape {
  protected static _tempPositionPoint: Vector2 = new Vector2();

  /** Radius of the shape to emit particles from. */
  radius: number = 1.0;
  /** Angle of the circle arc to emit particles from. */
  arc: number = (360.0 / 180.0) * Math.PI;
  /** The mode to generate particles around the arc. */
  arcMode = ParticleShapeMultiModeValue.Loop;

  constructor() {
    super();
    this.shapeType = ParticleShapeType.Circle;
  }

  override _generatePositionAndDirection(rand: Rand, position: Vector3, direction: Vector3): void {
    const positionPoint: Vector2 = CircleShape._tempPositionPoint;

    switch (this.arcMode) {
      case ParticleShapeMultiModeValue.Loop:
        ShapeUtils.randomPointUnitArcCircle(this.arc, CircleShape._tempPositionPoint, rand);
        break;
      case ParticleShapeMultiModeValue.Random:
        ShapeUtils.randomPointInsideUnitArcCircle(this.arc, CircleShape._tempPositionPoint, rand);
        break;
    }

    position.x = -positionPoint.x;
    position.y = positionPoint.y;
    position.z = 0;

    Vector3.scale(position, this.radius, position);

    if (this.randomDirectionAmount) {
      ShapeUtils._randomPointUnitSphere(direction, rand);
    } else {
      direction.copyFrom(position);
    }
    // reverse to default direction
    direction.z *= -1.0;
  }

  override cloneTo(destShape: CircleShape): void {
    super.cloneTo(destShape);
    destShape.radius = this.radius;
    destShape.arc = this.arc;
    destShape.arcMode = this.arcMode;
    destShape.randomDirectionAmount = this.randomDirectionAmount;
  }

  override clone(): CircleShape {
    const destShape = new CircleShape();
    this.cloneTo(destShape);
    return destShape;
  }
}