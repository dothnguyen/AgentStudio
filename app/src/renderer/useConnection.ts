import { useEffect, useState } from 'react';
import { INITIAL_STATUS, type ConnectionApi, type ConnectionStatus } from './api';

export function useConnection(api: ConnectionApi): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>(INITIAL_STATUS);
  useEffect(() => api.onChange(setStatus), [api]);
  return status;
}
