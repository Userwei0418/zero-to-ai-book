ARG PYTHON_IMAGE=python:3.12-slim-bookworm
FROM ${PYTHON_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 MPLBACKEND=Agg \
    MPLCONFIGDIR=/tmp/matplotlib OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1

COPY requirements.txt /opt/kernel/requirements.txt
RUN python -m pip install --no-cache-dir --only-binary=:all: -r /opt/kernel/requirements.txt \
    && groupadd --gid 10001 learner \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /workspace/lesson learner \
    && mkdir -p /workspace \
    && chown 10001:10001 /workspace
COPY --chown=root:root kernel.py validation.py guest_model.py /opt/kernel/
RUN chmod 0555 /opt/kernel/kernel.py /opt/kernel/validation.py /opt/kernel/guest_model.py

USER 10001:10001
WORKDIR /opt/kernel
ENTRYPOINT ["python", "-I", "/opt/kernel/kernel.py"]
