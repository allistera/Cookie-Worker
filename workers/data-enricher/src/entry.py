from workers import WorkerEntrypoint


class Default(WorkerEntrypoint):
    async def scheduled(self, controller, env, ctx):
        print("hello world")
