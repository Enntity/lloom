import torch
from a2v import A2VidPipelineTwoStage
from ltx_core.types import LatentState
from ltx_pipelines.distilled import ANCESTRAL_NOISE_SEED_OFFSET
from ltx_pipelines.utils.types import DenoisedLatentResult, VideoAudio
p=A2VidPipelineTwoStage.__new__(A2VidPipelineTwoStage);p.dtype=torch.float32;p.sampler='euler';assert p._sampler_kwargs(9,ANCESTRAL_NOISE_SEED_OFFSET)=={}
p.sampler='euler_ancestral';loop=p._sampler_kwargs(9,ANCESTRAL_NOISE_SEED_OFFSET)['loop']
source=torch.randn(1,4,3);seen=[]
a=LatentState(latent=source.clone(),clean_latent=source.clone(),denoise_mask=torch.zeros(1,4,1),positions=torch.zeros(1,1,4,2),frozen=True)
v=LatentState(latent=torch.zeros(1,4,3),clean_latent=torch.zeros(1,4,3),denoise_mask=torch.ones(1,4,1),positions=torch.zeros(1,1,4,2))
def denoiser(transformer,video,audio,sigmas,i):
 assert torch.equal(audio.latent,source),'Frozen audio changed during ancestral sampling'
 seen.append(i)
 return VideoAudio(video=DenoisedLatentResult(denoised=torch.zeros_like(video.latent)),audio=DenoisedLatentResult(denoised=torch.ones_like(audio.latent)))
out=loop(torch.tensor([1.,.7,.3,0.]),v,a,None,denoiser)
assert torch.equal(out.audio.latent,source) and seen==[0,1,2]
print('PASS: actual native ancestral loop preserves supplied frozen audio at every step')
