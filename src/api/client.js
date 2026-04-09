export const API_URL =
  'https://cb.hashhedge.com/v1/cfd/trade/finish' +
  '?page=1&pageSize=1000&rows=1000&contractType=1&quote=usdt&marginCurrency=usdt';

/**
 * Normalizes different API response envelopes to a plain array.
 * Checks the most common structures seen in trading platform APIs.
 */
export function extractTrades(data) {
  if (Array.isArray(data))                              return data;
  if (data?.data && Array.isArray(data.data))           return data.data;
  if (data?.data?.list && Array.isArray(data.data.list)) return data.data.list;
  if (data?.data?.records && Array.isArray(data.data.records)) return data.data.records;
  if (data?.data?.rows && Array.isArray(data.data.rows)) return data.data.rows;
  if (data?.list && Array.isArray(data.list))           return data.list;
  if (data?.records && Array.isArray(data.records))     return data.records;
  if (data?.rows && Array.isArray(data.rows))           return data.rows;
  throw new Error('Unrecognised API response shape. Raw: ' + JSON.stringify(data).slice(0, 200));
}
