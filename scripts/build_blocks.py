"""Build four orange-acrylic slabs and export a single GLB.

Tested with Blender 5.1 (also valid for 4.x). The Principled BSDF transmission
socket is named "Transmission Weight" in 4.x/5.x (it was "Transmission" in 3.x).

Run headless:
  blender --background --python scripts/build_blocks.py
Optional output override:
  OUT=/path/to/model.glb blender --background --python scripts/build_blocks.py
"""

import bpy
import bmesh
import os
from math import radians

# ── Parameters ───────────────────────────────────────────────────────────────
OUTPUT_PATH = os.environ.get(
    "OUT", os.path.join(os.getcwd(), "model.glb")
)

LENGTH, WIDTH, THICK = 4.0, 1.6, 0.0825  # per-slab dimensions (thin slabs)
INSET, RECESS = 0.05, 0.0033            # shallow, subtle tray lip (thin lip)
BEVEL_W, BEVEL_SEG = 0.012, 3           # polished edge chamfer
GAP = 0.33                              # vertical gap (kept while slabs thinned)
SPACING_Z = THICK + GAP
OFF_X, OFF_Y = 0.0, 0.0                # aligned stack (no diagonal lean)
SHARP_ANGLE = radians(30)               # smooth below this, flat above

# ── Empty scene ──────────────────────────────────────────────────────────────
bpy.ops.wm.read_factory_settings(use_empty=True)

# ── Base slab: box → recessed top tray ───────────────────────────────────────
bm = bmesh.new()
bmesh.ops.create_cube(bm, size=1.0)
for v in bm.verts:
    v.co.x *= LENGTH
    v.co.y *= WIDTH
    v.co.z *= THICK
bm.normal_update()
# Recess the top face inward (INSET) and down (RECESS) → a tray lip.
top = max(bm.faces, key=lambda f: f.calc_center_median().z)
bmesh.ops.inset_region(
    bm, faces=[top], thickness=INSET, depth=-RECESS, use_even_offset=True
)
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
base = bpy.data.meshes.new("Slab")
bm.to_mesh(base)
bm.free()

# ── Bake the bevel modifier (polished edges) into the mesh ───────────────────
tmp = bpy.data.objects.new("tmp", base)
bpy.context.scene.collection.objects.link(tmp)
bev = tmp.modifiers.new("Bevel", "BEVEL")
bev.width = BEVEL_W
bev.segments = BEVEL_SEG
bev.limit_method = "NONE"      # bevel every edge
bev.use_clamp_overlap = True
bpy.context.view_layer.update()
deps = bpy.context.evaluated_depsgraph_get()
final = bpy.data.meshes.new_from_object(tmp.evaluated_get(deps))
final.name = "SlabFinal"
bpy.data.objects.remove(tmp, do_unlink=True)

# ── Smooth shading: smooth faces, keep flat-face edges sharp, normals outward ─
bm = bmesh.new()
bm.from_mesh(final)
for f in bm.faces:
    f.smooth = True
for e in bm.edges:
    if len(e.link_faces) == 2 and e.calc_face_angle() > SHARP_ANGLE:
        e.smooth = False
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
bm.to_mesh(final)
bm.free()

# ── Material: OrangeAcrylic (glTF-compatible) ────────────────────────────────
mat = bpy.data.materials.new("OrangeAcrylic")
mat.use_nodes = True
nt = mat.node_tree
bsdf = nt.nodes["Principled BSDF"]
print("Principled BSDF sockets:", [i.name for i in bsdf.inputs])
bsdf.inputs["Base Color"].default_value = (0.95, 0.42, 0.12, 1.0)
bsdf.inputs["Alpha"].default_value = 1.0
bsdf.inputs["Roughness"].default_value = 0.03
bsdf.inputs["IOR"].default_value = 1.45
bsdf.inputs["Transmission Weight"].default_value = 1.0  # 4.x/5.x socket name

# Volume absorption → KHR_materials_volume. Thicker light paths deepen toward
# red-orange. attenuationColor = node Color, attenuationDistance = 1 / Density.
out = nt.nodes["Material Output"]
vol = nt.nodes.new("ShaderNodeVolumeAbsorption")
vol.inputs["Color"].default_value = (0.75, 0.12, 0.03, 1.0)  # deep red-orange
vol.inputs["Density"].default_value = 2.0  # → attenuationDistance ≈ 0.5
nt.links.new(vol.outputs["Volume"], out.inputs["Volume"])

# The glTF exporter only emits KHR_materials_volume when it can read a non-zero
# "Thickness" from a "glTF Material Output" node group. Build that group and add
# it to the material (it is read by name; it needn't be connected).
GLTF_SETTINGS = "glTF Material Output"
settings = bpy.data.node_groups.get(GLTF_SETTINGS)
if settings is None:
    settings = bpy.data.node_groups.new(GLTF_SETTINGS, "ShaderNodeTree")
    settings.interface.new_socket("Occlusion", socket_type="NodeSocketFloat")
    settings.interface.new_socket("Thickness", socket_type="NodeSocketFloat")
    settings.nodes.new("NodeGroupOutput")
    settings.nodes.new("NodeGroupInput").location = (-200, 0)
gltf_settings = nt.nodes.new("ShaderNodeGroup")
gltf_settings.node_tree = settings
gltf_settings.location = (300, -200)
gltf_settings.inputs["Thickness"].default_value = 0.5  # → thicknessFactor

final.materials.append(mat)

# ── Four slabs, shared mesh + material, leaning on a diagonal ────────────────
for i in range(4):
    obj = bpy.data.objects.new(f"Slab_{i + 1}", final)
    obj.location = (
        (i - 1.5) * OFF_X,
        (i - 1.5) * OFF_Y,
        (i - 1.5) * SPACING_Z,
    )
    bpy.context.scene.collection.objects.link(obj)

# ── Export ───────────────────────────────────────────────────────────────────
bpy.ops.export_scene.gltf(
    filepath=OUTPUT_PATH,
    export_format="GLB",
    export_apply=True,         # apply modifiers
    export_normals=True,
    export_materials="EXPORT",
)
print("WROTE:", OUTPUT_PATH)
