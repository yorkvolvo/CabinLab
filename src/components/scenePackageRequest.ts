export async function scenePackageRequest(path: string, body?: unknown, signal?: AbortSignal) {
  const response = await fetch(path, {
    signal,
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '场景包请求失败，请重试。');
  return data;
}
