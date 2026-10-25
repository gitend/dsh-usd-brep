import json, usd_brep

box = usd_brep.primitives.create_box((0, 0, 0), 2.0, 2.0, 2.0)
doc = usd_brep.fillet_edges.__doc__
# 取边列表：Brep.edges() 返回什么？怎么传给 fillet_edges？
edges = box.edges()
edge_type = type(edges)
edge_list = list(edges) if hasattr(edges, "__iter__") else edges
fil = usd_brep.fillet_edges(box, edge_list, radius=0.1)
print(json.dumps({
    "doc_head": doc[:260],
    "edges_ret_type": str(edge_type),
    "edge_count": len(edge_list),
    "fillet_ok_faces": fil.face_count(),
}))