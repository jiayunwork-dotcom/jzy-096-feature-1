import { createApp } from './app';

const port = Number(process.env.PORT ?? 8080);

createApp().listen(port, () => {
  console.log(`turn-restricted router listening on port ${port}`);
});
