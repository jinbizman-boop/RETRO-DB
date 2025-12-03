export const onRequestGet: PagesFunction = async () => {
  return new Response(JSON.stringify({ ok: true, service: "retro-db" }), {
    headers: { "Content-Type": "application/json" },
  });
};
